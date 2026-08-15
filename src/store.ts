import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

export function sha256(buf: Uint8Array): string {
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
	const abs = join(ROOT, rel);
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

export function readRaw(rawPath: string): Buffer {
	return readFileSync(join(ROOT, rawPath));
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
