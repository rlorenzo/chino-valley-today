// Render reports/poc.html from the DB + reports/poc-data.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, type Db } from './db/index.ts';
import { ROOT } from './store.ts';

function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderReport(dbIn?: Db): void {
  const db = dbIn ?? openDb();
  const dataPath = join(ROOT, 'reports', 'poc-data.json');
  const runData = existsSync(dataPath)
    ? (JSON.parse(readFileSync(dataPath, 'utf8')) as {
        ranAt: string;
        results: Array<{
          key: string;
          name: string;
          method: string;
          ok: boolean;
          implemented: boolean;
          error?: string;
          counts?: Record<string, number>;
          notes: string[];
          durationMs: number;
        }>;
      })
    : { ranAt: 'never', results: [] };

  const sections: string[] = [];
  const summaryRows: string[] = [];

  for (const r of runData.results) {
    const source = db.raw.prepare('SELECT id FROM sources WHERE key = ?').get(r.key) as
      | { id: number }
      | undefined;
    const itemCount = source
      ? (db.raw
          .prepare(
            'SELECT COUNT(*) AS n FROM items i JOIN documents d ON i.document_id = d.id WHERE d.source_id = ?'
          )
          .get(source.id) as { n: number }).n
      : 0;
    const docCount = source
      ? (db.raw.prepare('SELECT COUNT(*) AS n FROM documents WHERE source_id = ?').get(source.id) as {
          n: number;
        }).n
      : 0;
    const samples = source
      ? (db.raw
          .prepare(
            `SELECT i.item_type, i.title, i.occurred_at, i.source_url
             FROM items i JOIN documents d ON i.document_id = d.id
             WHERE d.source_id = ? ORDER BY i.id DESC LIMIT 10`
          )
          .all(source.id) as Array<Record<string, string>>)
      : [];

    const status = !r.implemented ? 'not implemented' : r.ok ? 'ok' : 'FAILED';
    summaryRows.push(
      `<tr class="${r.ok ? 'ok' : 'bad'}"><td>${esc(r.key)}</td><td>${esc(r.method)}</td><td>${esc(
        status
      )}</td><td>${docCount}</td><td>${itemCount}</td><td>${r.durationMs}ms</td></tr>`
    );

    sections.push(`
<section>
  <h2>${esc(r.name)} <code>${esc(r.key)}</code> — ${esc(status)}</h2>
  <p><b>method:</b> ${esc(r.method)} · <b>documents:</b> ${docCount} · <b>items:</b> ${itemCount}
  ${r.counts ? ` · <b>this run:</b> ${esc(JSON.stringify(r.counts))}` : ''}</p>
  ${r.error ? `<p class="err"><b>error:</b> ${esc(r.error)}</p>` : ''}
  ${
    r.notes.length
      ? `<h3>Notes</h3><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
      : ''
  }
  ${
    samples.length
      ? `<h3>Sample items</h3><table><tr><th>type</th><th>title</th><th>occurred</th><th>source link</th></tr>${samples
          .map(
            (s) =>
              `<tr><td>${esc(s.item_type)}</td><td>${esc((s.title ?? '').slice(0, 120))}</td><td>${esc(
                s.occurred_at
              )}</td><td><a href="${esc(s.source_url)}">${esc(s.source_url?.slice(0, 90))}</a></td></tr>`
          )
          .join('')}</table>`
      : '<p><i>no items stored</i></p>'
  }
</section>`);
  }

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Chino Valley Today — Scraper POC report</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
  th, td { border: 1px solid #ccc; padding: .3rem .5rem; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  tr.bad td { background: #fdecea; }
  code { background: #f4f4f4; padding: 0 .3em; }
  .err { color: #b00020; }
  section { margin-bottom: 2rem; border-top: 2px solid #ddd; padding-top: 1rem; }
  a { word-break: break-all; }
</style>
<h1>Chino Valley Today — Scraper POC</h1>
<p>Run at: ${esc(runData.ranAt)}</p>
<h2>Summary</h2>
<table>
<tr><th>source</th><th>method</th><th>status</th><th>documents</th><th>items</th><th>duration</th></tr>
${summaryRows.join('\n')}
</table>
${sections.join('\n')}
`;

  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(join(ROOT, 'reports', 'poc.html'), html);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  renderReport();
  console.log('wrote reports/poc.html');
}
