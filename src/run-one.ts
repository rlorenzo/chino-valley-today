// Run a single scraper by key: node src/run-one.ts <key> [scraper-specific args]

import { buildContext } from "./context.ts";
import { openDb } from "./db/index.ts";
import { SCRAPERS } from "./scrapers/registry.ts";
import type { ScraperDef } from "./scrapers/types.ts";

const key = process.argv[2];
if (!key || !(key in SCRAPERS)) {
	console.error(
		`usage: node src/run-one.ts <key>\nkeys: ${Object.keys(SCRAPERS).join(", ")}`,
	);
	process.exit(1);
}

const mod = await import(SCRAPERS[key]);
const def = mod.default as ScraperDef;
const db = openDb();
const { ctx, notes } = buildContext(db, def);

const t0 = Date.now();
let ok = true;
try {
	await def.run(ctx, process.argv.slice(3));
} catch (err) {
	ok = false;
	console.error(`FAILED after ${Date.now() - t0}ms:`, err);
}

console.log(
	`\n=== ${def.key} ${ok ? "OK" : "FAILED"} in ${Date.now() - t0}ms ===`,
);
console.log("counts:", JSON.stringify(ctx.counts));
if (notes.length)
	console.log(`notes:\n${notes.map((n) => `  - ${n}`).join("\n")}`);

const samples = db.raw
	.prepare(
		`SELECT i.item_type, i.title, i.occurred_at, i.source_url
     FROM items i JOIN documents d ON i.document_id = d.id
     WHERE d.source_id = ? ORDER BY i.id DESC LIMIT 8`,
	)
	.all(ctx.sourceId);
console.log("\nsample items:");
for (const s of samples as Array<Record<string, unknown>>) {
	console.log(
		`  [${s.item_type}] ${String(s.title ?? "").slice(0, 90)} (${s.occurred_at ?? "n/a"})`,
	);
	console.log(`    -> ${s.source_url}`);
}
process.exit(ok ? 0 : 1);
