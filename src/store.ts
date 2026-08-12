import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

// Content-addressed raw archive: data/raw/<first-2-hex>/<sha256>.<ext>
// Returns rawPath relative to the repo root (that relative form is what goes in the DB).
export function saveRaw(body: Uint8Array, ext: string): { hash: string; rawPath: string } {
  const hash = sha256(body);
  const rel = join('data', 'raw', hash.slice(0, 2), `${hash}.${ext}`);
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return { hash, rawPath: rel };
}

export function readRaw(rawPath: string): Buffer {
  return readFileSync(join(ROOT, rawPath));
}

const EXT_BY_TYPE: Array<[RegExp, string]> = [
  [/application\/pdf/, 'pdf'],
  [/text\/html/, 'html'],
  [/application\/(ld\+)?json|application\/geo\+json/, 'json'],
  [/xml|rss/, 'xml'],
  [/text\/vtt/, 'vtt'],
  [/text\/csv|application\/csv/, 'csv'],
  [/text\/plain/, 'txt'],
];

export function extFor(contentType: string | null, url: string): string {
  if (contentType) {
    for (const [re, ext] of EXT_BY_TYPE) if (re.test(contentType)) return ext;
  }
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  if (m) return m[1].toLowerCase();
  return 'bin';
}
