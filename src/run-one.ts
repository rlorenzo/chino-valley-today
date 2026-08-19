// Run a single scraper by key: node src/run-one.ts <key> [scraper-specific args]

import { buildContext } from "./context.ts";
import { openDb } from "./db/index.ts";
import { SOURCE_TOS_REGISTRY } from "./gates/tos-config.ts";
import { SCRAPERS } from "./scrapers/registry.ts";
import type { ScraperDef } from "./scrapers/types.ts";
import { errorMessage } from "./utils/errors.ts";

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

// Only the secondary-press sources are gated on publisher terms; the civic and
// agency sources publish their own records and carry no such contract. Asking
// the gate about an ungated source is not a neutral question — the gate fails
// closed by design, so consulting it for all 22 scrapers would hold the 20
// civic ones for terms that were never meant to apply to them.
const tos = Object.hasOwn(SOURCE_TOS_REGISTRY, def.key)
	? db.getSourceTosStatus(def.key)
	: null;
if (tos?.status === "held") {
	console.error(
		`Scraper ${def.key} is HELD due to ToS status (${tos.heldReason ?? "unknown"}). Skipping execution.`,
	);
	const runId = db.startScrapeRun(def.key);
	db.finishScrapeRun(runId, {
		status: "failure",
		errorMessage: `Scraper held: ToS hold active (${tos.heldReason ?? "unknown"})`,
		documentsCount: 0,
		itemsCount: 0,
	});
	process.exit(1);
}

const { ctx, notes } = buildContext(db, def);

const runId = db.startScrapeRun(def.key);
const t0 = Date.now();
let ok = true;
let errorMsg: string | null = null;
try {
	await def.run(ctx, process.argv.slice(3));
} catch (err) {
	ok = false;
	errorMsg = errorMessage(err);
	console.error(`FAILED after ${Date.now() - t0}ms:`, err);
}

db.finishScrapeRun(runId, {
	status: ok ? "success" : "failure",
	errorMessage: errorMsg,
	documentsCount: ctx.counts.documentsFetched,
	itemsCount: ctx.counts.itemsSeen,
});

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
