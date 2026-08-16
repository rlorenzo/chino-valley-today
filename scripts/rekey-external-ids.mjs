// One-time data migration for the external_id scoping change.
//
// cvusd-board and chino-agendacenter used to build external_id as `<date>-<n>`
// (and `<date>-meeting`), which collides when a source holds more than one
// meeting on a date — a Regular and a Special CVUSD meeting, or two Chino
// commissions. Those scrapers now scope the id with the meeting type / body
// name via meetingScopedId().
//
// Existing rows keep the OLD id, so without this migration the next scrape
// inserts the same items again under the new ids: duplicates, which is exactly
// the failure the change prevents. The discriminator is already stored on each
// row (meta.meetingType, meta.body), so the re-key is deterministic.
//
//   node scripts/rekey-external-ids.mjs --dry-run   (default: shows the plan)
//   node scripts/rekey-external-ids.mjs --apply
//
// Idempotent: rows already in the new form are skipped, so re-running is a no-op.
import { openDb } from "../src/db/index.ts";
import { idSlug, meetingScopedId } from "../src/scrapers/external-id.ts";

const apply = process.argv.includes("--apply");

// sourceKey -> which meta field carries the discriminator for that source.
const DISCRIMINATOR_BY_SOURCE = {
	"cvusd-board": "meetingType",
	"chino-agendacenter": "body",
};

const db = openDb();

const rows = db.raw
	.prepare(
		`SELECT i.id, i.external_id, i.item_type, i.meta, d.url AS docUrl, s.key AS sourceKey
       FROM items i
       JOIN documents d ON d.id = i.document_id
       JOIN sources s ON s.id = d.source_id
      WHERE s.key IN ('cvusd-board', 'chino-agendacenter')`,
	)
	.all();

const planned = [];
const skipped = [];

for (const row of rows) {
	const metaField = DISCRIMINATOR_BY_SOURCE[row.sourceKey];
	let discriminator = null;
	try {
		discriminator = JSON.parse(row.meta ?? "{}")[metaField] ?? null;
	} catch {
		discriminator = null;
	}
	if (!discriminator) {
		skipped.push({ ...row, reason: `no meta.${metaField} to scope with` });
		continue;
	}

	// Recover the date prefix and the trailing suffix from the OLD id, which is
	// always `<iso-date>-<suffix>`.
	const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(row.external_id ?? "");
	if (!m) {
		skipped.push({ ...row, reason: "id is not <date>-<suffix>" });
		continue;
	}
	const [, isoDate, suffix] = m;
	// Idempotence: once scoped, the suffix already begins with the slug. Without
	// this the regex happily re-parses the NEW id and prefixes the slug again,
	// turning "<date>-special-meeting" into "<date>-special-special-meeting".
	const slug = idSlug(discriminator);
	if (slug && (suffix === slug || suffix.startsWith(`${slug}-`))) {
		skipped.push({ ...row, reason: "already scoped" });
		continue;
	}
	const next = meetingScopedId(isoDate, discriminator, suffix);
	if (next === row.external_id) {
		skipped.push({ ...row, reason: "already scoped" });
		continue;
	}
	planned.push({ id: row.id, from: row.external_id, to: next });
}

console.log(`rows examined: ${rows.length}`);
console.log(`to re-key:     ${planned.length}`);
console.log(`skipped:       ${skipped.length}`);
for (const s of skipped)
	console.log(`  skip #${s.id} ${s.external_id} — ${s.reason}`);
for (const p of planned) console.log(`  ${p.from}  ->  ${p.to}`);

// A collision would merge two rows into one item — the exact failure this
// change prevents, so refuse rather than write.
//
// The namespace is (document url, item_type, external_id), NOT external_id
// alone: identical ids under different documents or item types are not a
// collision, and checking the id alone would abort a valid migration. It also
// has to include rows this run is NOT touching — a planned id can land on an
// already-scoped row's id — so every item in the DB is projected to its
// post-migration identity first.
const finalById = new Map(planned.map((p) => [p.id, p.to]));

const allItems = db.raw
	.prepare(
		`SELECT i.id, i.external_id, i.item_type, d.url AS docUrl
       FROM items i
       JOIN documents d ON d.id = i.document_id`,
	)
	.all();

const identity = new Map();
for (const item of allItems) {
	const finalId = finalById.get(item.id) ?? item.external_id;
	// \u0000 cannot occur in a url, item_type or external_id, so it is a safe
	// separator for a composite map key.
	const key = `${item.docUrl}\u0000${item.item_type}\u0000${finalId}`;
	const other = identity.get(key);
	if (other !== undefined) {
		console.error(
			`FATAL: items #${other} and #${item.id} would share one identity:\n` +
				`  url=${item.docUrl}\n  item_type=${item.item_type}\n  external_id=${finalId}`,
		);
		process.exit(1);
	}
	identity.set(key, item.id);
}
console.log(`identity check: ${allItems.length} item(s), no collisions`);

if (!apply) {
	console.log("\nDry run. Re-run with --apply to write.");
	process.exit(0);
}

const update = db.raw.prepare("UPDATE items SET external_id = ? WHERE id = ?");
db.raw.exec("BEGIN IMMEDIATE");
try {
	for (const p of planned) update.run(p.to, p.id);
	db.raw.exec("COMMIT");
	console.log(`\nRe-keyed ${planned.length} row(s).`);
} catch (err) {
	db.raw.exec("ROLLBACK");
	throw err;
}
