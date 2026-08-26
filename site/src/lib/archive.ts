/**
 * Build-time access to the raw archive — the content-addressed bytes under
 * data/raw/ and the documents table that describes them.
 *
 * The site otherwise renders only content/published/, and this is the one place
 * it reaches further: the archive IS what a citation now points at, so the pages
 * that serve it have to be built from it. Read-only throughout; the build must
 * never write to the pipeline's database.
 *
 * On a developer checkout there is usually no data/ at all (it is gitignored),
 * and that is not an error — it means zero archive pages. What IS an error is a
 * published post citing an archive page the build cannot produce, and
 * pages/source/[hash].astro fails the build on exactly that.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The repo root, found by walking up from the working directory.
 *
 * NOT derived from import.meta.url, which is the obvious way and the wrong one:
 * Astro bundles this module into site/dist/.prerender/chunks/, so at the moment
 * getStaticPaths actually runs, import.meta.url points inside the build output
 * and every archive lookup silently finds nothing. Silently is the bad part —
 * the build still succeeds, just without a single archive page.
 *
 * `data/` and `content/` together pin this to THIS repo's layout rather than to
 * any ancestor that happens to have a data directory. Overridable, for the same
 * reason src/store.ts makes its archive root overridable: a test needs to point
 * somewhere disposable.
 */
function findRepoRoot(): string | null {
	if (process.env.CVT_ROOT) return process.env.CVT_ROOT;
	let dir = process.cwd();
	for (;;) {
		if (existsSync(join(dir, "data")) && existsSync(join(dir, "content"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

const REPO_ROOT = findRepoRoot();

const DB_PATH =
	process.env.CVT_DB ??
	(REPO_ROOT ? join(REPO_ROOT, "data", "cvtoday.db") : null);

/** One archived fetch: the bytes, and what the pipeline knows about them. */
export interface ArchiveDocument {
	/** sha256 of the bytes. The page's whole address. */
	hash: string;
	/** data/raw/<xx>/<sha256>.<ext>, relative to the repo root. */
	rawPath: string;
	/** The source's own URL. The authority — the archive page is a mirror. */
	url: string;
	docType: string;
	title: string | null;
	/** ISO instant the pipeline fetched these bytes. */
	fetchedAt: string;
	sourceKey: string;
	sourceName: string;
	/** Size on disk, or null when the entry is recorded but the file is gone. */
	bytes: number | null;
}

interface DocRow {
	content_hash: string;
	raw_path: string;
	url: string;
	doc_type: string;
	title: string | null;
	fetched_at: string;
	source_key: string;
	source_name: string;
}

/**
 * The archive page path a URL names, or null.
 *
 * Matched on the PATHNAME, and only the pathname. Two decisions here:
 *
 * The host is deliberately not checked. The interim host and the branded domain
 * serve the same build (see astro.config.mjs), and a citation is minted once
 * against whichever CVT_SITE_ORIGIN was set at generation time and then baked
 * into a post forever. An origin test would stop recognising our own older
 * citations the moment those two differ — and the failure would be silent,
 * because the build guard would then quietly stop guarding them. A false
 * positive is loud (the build demands a page); a false negative is not.
 *
 * But it is matched against `URL.pathname` rather than against the raw string,
 * so a `/source/<hash>/` sitting in someone else's query string or fragment is
 * not mistaken for a path. A URL that will not parse is not one of ours.
 */
export function archiveHashFromUrl(url: string): string | null {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return null;
	}
	const match = pathname.match(/^\/source\/([0-9a-f]{64})\/?$/);
	return match ? match[1] : null;
}

// Read once per build. Every page that renders a citation asks about the
// archive, and a build opens the database once per ask otherwise.
let cache: Map<string, ArchiveDocument> | null = null;

/**
 * Every archived document, by content hash.
 *
 * Empty when there is no database — a checkout without data/ builds a site
 * without archive pages, which is honest, rather than failing on content it was
 * never given. What must NOT pass silently is a published post citing an
 * archive page; pages/source/[hash].astro fails the build on that.
 */
function archiveIndex(): Map<string, ArchiveDocument> {
	if (cache) return cache;
	cache = new Map();
	if (!DB_PATH || !existsSync(DB_PATH)) return cache;
	const db = new DatabaseSync(DB_PATH, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT d.content_hash, d.raw_path, d.url, d.doc_type, d.title, d.fetched_at,
                s.key AS source_key, s.name AS source_name
           FROM documents d
           JOIN sources s ON s.id = d.source_id
          ORDER BY d.fetched_at DESC, d.id DESC`,
			)
			.all() as unknown as DocRow[];

		// documents is UNIQUE(url, content_hash), not UNIQUE(content_hash): the
		// same bytes served at two URLs are two rows over one archive entry, and
		// two rows would mean two getStaticPaths entries at one path, which Astro
		// rejects. First row wins, which the ORDER BY makes the newest fetch.
		for (const r of rows) {
			if (cache.has(r.content_hash)) continue;
			cache.set(r.content_hash, {
				hash: r.content_hash,
				rawPath: r.raw_path,
				url: r.url,
				docType: r.doc_type,
				title: r.title,
				fetchedAt: r.fetched_at,
				sourceKey: r.source_key,
				sourceName: r.source_name,
				bytes: fileBytes(r.raw_path),
			});
		}
		return cache;
	} finally {
		db.close();
	}
}

/** Archived documents of the given types, newest fetch first. */
export function archiveDocuments(docTypes: string[]): ArchiveDocument[] {
	const wanted = new Set(docTypes);
	return [...archiveIndex().values()].filter((d) => wanted.has(d.docType));
}

/**
 * The document one archive citation points at, or null.
 *
 * This is what lets a citation to /source/<hash>/ still name its real authority
 * on the post page. A provenance stamp reading "chinovalley.today" would tell a
 * reader we are our own source, which is the provenance inflation the
 * inspection record exists to prevent.
 */
export function archiveDocumentFor(url: string): ArchiveDocument | null {
	const hash = archiveHashFromUrl(url);
	return hash ? (archiveIndex().get(hash) ?? null) : null;
}

function fileBytes(rawPath: string): number | null {
	try {
		return statSync(resolveInArchive(rawPath)).size;
	} catch {
		return null;
	}
}

/**
 * Absolute path of an archive entry, refusing anything outside data/raw/.
 *
 * Same guard as readRaw() in src/store.ts, and for the same reason: the value
 * arrives from a database column, so the answer must not depend on that column
 * only ever holding what saveRaw wrote.
 */
function resolveInArchive(rawPath: string): string {
	if (!REPO_ROOT)
		throw new Error("no repo root: nothing to read the archive from");
	const abs = resolve(REPO_ROOT, rawPath);
	const archiveDir = resolve(REPO_ROOT, "data", "raw") + sep;
	if (!abs.startsWith(archiveDir)) {
		throw new Error(`refusing to read outside the raw archive: ${rawPath}`);
	}
	return abs;
}

/** The archived bytes as text, or null when the entry is missing from disk. */
export function readArchiveText(rawPath: string): string | null {
	try {
		return readFileSync(resolveInArchive(rawPath), "utf8");
	} catch {
		return null;
	}
}

/** "41 KB" — a size a reader can weigh before opening the raw bytes. */
export function formatBytes(bytes: number | null): string | null {
	if (bytes === null) return null;
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
