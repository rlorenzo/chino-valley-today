// Calibration utility (not part of the pipeline): runs Gate 1 against real
// published post files, reconstructing inputCorpus from the DB rows behind
// each post's frontmatter `sources`. Tier A posts are verbatim template
// renders of source data, so they SHOULD pass; a failure here is evidence
// about gate calibration, not about the post being wrong.
//
// Usage: node src/gates/check-real-post.ts [content/published/<file>.md ...]
// With no args, checks every file in content/published/.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, ROOT } from '../db/index.ts';
import { validateDraft } from './validators.ts';

function parseFrontmatter(raw: string): { sources: string[]; bodyMd: string; title: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('no frontmatter found');
  const [, fm, body] = m;
  const sources: string[] = [];
  let inSources = false;
  let title = '';
  for (const line of fm.split('\n')) {
    if (/^sources:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources) {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) {
        sources.push(JSON.parse(item[1].trim()));
        continue;
      }
      inSources = false;
    }
    const t = line.match(/^title:\s*(.+)$/);
    if (t) title = JSON.parse(t[1].trim());
  }
  return { sources, bodyMd: body, title };
}

function corpusForSources(db: ReturnType<typeof openDb>, sources: string[]): string {
  const parts: string[] = [];
  for (const url of sources) {
    const rows = db.raw
      .prepare('SELECT title, body, meta, occurred_at FROM items WHERE source_url = ?')
      .all(url) as unknown as { title: string | null; body: string | null; meta: string | null; occurred_at: string | null }[];
    if (rows.length === 0) {
      // Fall back to the documents table — an item's citable source_url can
      // legitimately differ from documents.url (deepest-link vs fetch-origin;
      // see PLAN.md schema notes), and a Tier A post can also cite a
      // document-level URL directly (e.g. a calendar entry) with no items row.
      const docs = db.raw
        .prepare('SELECT title, url, doc_type, meeting_date, location FROM documents WHERE url = ?')
        .all(url) as unknown as { title: string | null; url: string; doc_type: string; meeting_date: string | null; location: string | null }[];
      for (const d of docs) parts.push([d.title, d.doc_type, d.meeting_date, d.location].filter(Boolean).join(' '));
      continue;
    }
    for (const r of rows) {
      parts.push([r.title, r.body, r.meta, r.occurred_at].filter(Boolean).join(' '));
    }
  }
  return parts.join('\n\n');
}

function main(): void {
  const db = openDb();
  const argFiles = process.argv.slice(2);
  const files =
    argFiles.length > 0
      ? argFiles
      : readdirSync(join(ROOT, 'content', 'published'))
          .filter((f) => f.endsWith('.md'))
          .map((f) => join('content', 'published', f));

  for (const relPath of files) {
    const abs = relPath.startsWith('/') ? relPath : join(ROOT, relPath);
    const raw = readFileSync(abs, 'utf8');
    const { sources, bodyMd, title } = parseFrontmatter(raw);
    const inputCorpus = corpusForSources(db, sources);
    const report = validateDraft({ bodyMd, allowedUrls: sources, inputCorpus });

    console.log(`\n=== ${relPath} — "${title}" ===`);
    console.log(`sources: ${sources.length}, corpus chars: ${inputCorpus.length}`);
    console.log(`pass: ${report.pass}`);
    console.log(`stats: ${JSON.stringify(report.stats)}`);
    if (!report.pass) {
      for (const f of report.failures) {
        console.log(`  [${f.gate}] ${f.detail}${f.excerpt ? ` — "${f.excerpt}"` : ''}`);
      }
    }
  }
}

main();
