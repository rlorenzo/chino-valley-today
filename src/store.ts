import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

// Where the content-addressed archive lives. Overridable so a test can write
// its fixtures somewhere disposable: the real archive under data/raw is the
// project's moat, and filling it with strings a test invented is not losing it
// but is not keeping it either.
function archiveRoot(): string {
	return process.env.CVT_RAW_ROOT ?? ROOT;
}

function sha256(buf: Uint8Array): string {
	return createHash("sha256").update(buf).digest("hex");
}

// Content-addressed raw archive: data/raw/<first-2-hex>/<sha256>.<ext>
// Returns rawPath relative to the repo root (that relative form is what goes in the DB).
export function saveRaw(
	body: Uint8Array,
	ext: string,
): { hash: string; rawPath: string } {
	const hash = sha256(body);
	const rel = join("data", "raw", hash.slice(0, 2), `${hash}.${ext}`);
	const abs = join(archiveRoot(), rel);
	// The store is content-addressed, so an entry that already exists holds these
	// exact bytes and the write can be skipped. The write itself goes to a unique
	// temp file in the same directory and is renamed into place: writing straight
	// to `abs` lets a crashed or concurrent run leave a truncated file there,
	// which every later existsSync check then accepts as a complete archive entry.
	// rename(2) within one directory is atomic, so `abs` only ever appears whole.
	if (!existsSync(abs)) {
		mkdirSync(dirname(abs), { recursive: true });
		const tmp = `${abs}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tmp, body);
			renameSync(tmp, abs);
		} catch (err) {
			try {
				unlinkSync(tmp);
			} catch {
				// Best-effort cleanup; the temp file may never have been created.
			}
			throw err;
		}
	}
	return { hash, rawPath: rel };
}

// Reads an archive entry, refusing to read anything that is not one.
//
// `rawPath` comes back out of documents.raw_path, so it is only ever a value
// saveRaw wrote — but the containment check costs a resolve() and means the
// answer does not depend on that staying true. `join` would fold a "../.."
// straight out of the archive; `resolve` plus an explicit prefix test does not,
// and it also pins an absolute path, which join would have happily kept.
export function readRaw(rawPath: string): Buffer {
	const root = archiveRoot();
	const abs = resolve(root, rawPath);
	const archiveDir = resolve(root, "data", "raw") + sep;
	if (!abs.startsWith(archiveDir)) {
		throw new Error(`refusing to read outside the raw archive: ${rawPath}`);
	}
	return readFileSync(abs);
}

// Locates an archived entry by content hash alone, returning its rawPath or
// null. The extension is part of the filename and is not always known to the
// caller: source_tos_status stores the sha256 of a terms page and nothing else,
// and that hash is enough to find the bytes it names.
export function findRaw(hash: string): string | null {
	// The hash reaches this from a database column, and the result is a path.
	// Anything that is not a bare sha256 is not an archive entry, so it is
	// rejected here rather than turned into a directory traversal.
	if (!/^[0-9a-f]{64}$/.test(hash)) return null;
	const dir = join("data", "raw", hash.slice(0, 2));
	let entries: string[];
	try {
		entries = readdirSync(join(archiveRoot(), dir));
	} catch {
		return null;
	}
	const match = entries.find((name) => name.startsWith(`${hash}.`));
	return match ? join(dir, match) : null;
}

const EXT_BY_TYPE: Array<[RegExp, string]> = [
	[/application\/pdf/, "pdf"],
	[/text\/html/, "html"],
	[/application\/(ld\+)?json|application\/geo\+json/, "json"],
	[/xml|rss/, "xml"],
	[/text\/vtt/, "vtt"],
	[/text\/csv|application\/csv/, "csv"],
	[/text\/plain/, "txt"],
];

// The returned value is used as the filename extension in saveRaw, so it must
// never carry path separators or traversal: every branch returns either a
// hardcoded literal or a /[a-z0-9]{2,5}/ match, keeping the archive path
// entirely to <hex>/<hex>.<alnum> even though `url` is untrusted network input.
export function extFor(contentType: string | null, url: string): string {
	if (contentType) {
		for (const [re, ext] of EXT_BY_TYPE) if (re.test(contentType)) return ext;
	}
	const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
	if (m) return m[1].toLowerCase();
	return "bin";
}
