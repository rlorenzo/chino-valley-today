// npm run poc — run every scraper (each independently try/caught), write
// reports/poc-data.json, then render reports/poc.html.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, nowIso } from './db/index.ts';
import { ROOT } from './store.ts';
import { buildContext } from './context.ts';
import { SCRAPERS } from './scrapers/registry.ts';
import type { ScraperDef } from './scrapers/types.ts';
import { renderReport } from './poc-report.ts';

interface RunResult {
  key: string;
  name: string;
  method: string;
  ok: boolean;
  implemented: boolean;
  error?: string;
  counts?: import('./scrapers/types.ts').ScraperCounts;
  notes: string[];
  durationMs: number;
}

const db = openDb();
const results: RunResult[] = [];

for (const [key, modPath] of Object.entries(SCRAPERS)) {
  const t0 = Date.now();
  console.log(`\n### ${key}`);
  let def: ScraperDef;
  try {
    def = (await import(modPath)).default as ScraperDef;
  } catch (err) {
    results.push({
      key,
      name: key,
      method: 'n/a',
      ok: false,
      implemented: false,
      error: `not implemented (${err instanceof Error ? err.message.split('\n')[0] : err})`,
      notes: [],
      durationMs: 0,
    });
    console.log(`  skipped: no module at ${modPath}`);
    continue;
  }
  const { ctx, notes } = buildContext(db, def);
  try {
    await def.run(ctx);
    results.push({
      key,
      name: def.name,
      method: def.method,
      ok: true,
      implemented: true,
      counts: ctx.counts,
      notes,
      durationMs: Date.now() - t0,
    });
  } catch (err) {
    results.push({
      key,
      name: def.name,
      method: def.method,
      ok: false,
      implemented: true,
      error: err instanceof Error ? `${err.message}` : String(err),
      counts: ctx.counts,
      notes,
      durationMs: Date.now() - t0,
    });
    console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(
  join(ROOT, 'reports', 'poc-data.json'),
  JSON.stringify({ ranAt: nowIso(), results }, null, 2)
);

renderReport(db);

const okCount = results.filter((r) => r.ok).length;
console.log(`\n=== POC run complete: ${okCount}/${results.length} scrapers OK ===`);
console.log('report: reports/poc.html');
