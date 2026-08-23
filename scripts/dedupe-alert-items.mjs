// One-time cleanup of alert rows stored twice, one per NWS feed.
//
// src/scrapers/nws-alerts.ts fetches two documents — /alerts/active?zone= and
// /alerts?zone=&limit=10 — and used to store each feed's features on its own.
// Item identity is (document url, item_type, external_id), so an alert listed
// by both feeds (every currently-active one) resolved to no existing row the
// second time and was inserted again under the other document. 11 pairs on the
// production DB as of 2026-08-23.
//
// The scraper now collects across both feeds before storing, so no new pairs
// appear. This clears the ones already written.
//
// Keeps the LOWEST id of each pair: that is the active-feed sighting, inserted
// first, and it is the row anything downstream already referencing an alert
// would have matched (insertItem's own lookup is ORDER BY i.id LIMIT 1).
//
//   node scripts/dedupe-alert-items.mjs            (dry run)
//   node scripts/dedupe-alert-items.mjs --apply
//   node scripts/dedupe-alert-items.mjs --db /path/to/copy.db   (verify first)
import { openDb } from "../src/db/index.ts";

const apply = process.argv.includes("--apply");
const dbFlag = process.argv.indexOf("--db");
const db = dbFlag === -1 ? openDb() : openDb(process.argv[dbFlag + 1]);

const dupes = db.raw
	.prepare(
		`SELECT external_id, item_type, COUNT(*) AS n,
		        MIN(id) AS keep_id, GROUP_CONCAT(id) AS ids
		   FROM items
		  WHERE item_type = 'alert'
		  GROUP BY external_id, item_type
		 HAVING n > 1
		  ORDER BY keep_id`,
	)
	.all();

if (dupes.length === 0) {
	console.log("No duplicate alert rows found.");
	process.exit(0);
}

let removed = 0;
for (const row of dupes) {
	const ids = String(row.ids)
		.split(",")
		.map(Number)
		.filter((id) => id !== Number(row.keep_id));
	console.log(
		`${row.external_id}: keep ${row.keep_id}, drop ${ids.join(", ")}`,
	);
	if (apply) {
		for (const id of ids) {
			db.raw.prepare("DELETE FROM items WHERE id = ?").run(id);
			removed++;
		}
	}
}

console.log(
	apply
		? `Removed ${removed} duplicate alert row(s) across ${dupes.length} alert(s).`
		: `Dry run: ${dupes.length} alert(s) have duplicate rows. Re-run with --apply.`,
);
