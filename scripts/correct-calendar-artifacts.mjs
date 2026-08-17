// One-time correction of two City of Chino calendar-feed artifacts in ALREADY
// PUBLISHED preview posts.
//
// The generator was fixed (src/tiera/meeting-previews.ts), but createPost
// deliberately refuses to overwrite a published post, so existing files keep the
// old strings:
//
//   "13220 Central AvenueChino, CA 91710"  -> street run into the city
//   "06:00 PM - 11:59 PM"                  -> the feed's "no end specified"
//
// The second is substantive: it tells a reader the meeting runs six hours, which
// the source never claimed. EDITORIAL.md requires corrections to be visible and
// never silent, so each corrected post gains a dated correction note.
//
// Surgical on purpose: it rewrites only the Time and Location lines, never
// regenerates the post, so nothing else can drift.
//
//   node scripts/correct-calendar-artifacts.mjs            (dry run)
//   node scripts/correct-calendar-artifacts.mjs --apply
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/store.ts";
import {
	normalizeLocation,
	normalizeTimes,
} from "../src/tiera/meeting-previews.ts";

const apply = process.argv.includes("--apply");
// Pacific, not UTC: everything reader-facing on this site is America/Los_Angeles,
// and a UTC date would post-date the correction by a day all evening.
const CORRECTION_DATE = process.argv.includes("--date")
	? process.argv[process.argv.indexOf("--date") + 1]
	: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

const dir = join(ROOT, "content", "published");
const changed = [];

for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
	const path = join(dir, file);
	const original = readFileSync(path, "utf8");
	if (!/^post_type:\s*meeting_preview\s*$/m.test(original)) continue;

	let next = original;
	const notes = [];

	// Only the VALUE is rewritten; the trailing citation link is preserved.
	next = next.replace(
		/^(- \*\*Location:\*\* )([^(\n]+?)(\s*\()/m,
		(_m, head, value, tail) => {
			const fixed = normalizeLocation(value.trim());
			if (fixed && fixed !== value.trim()) notes.push("address");
			return `${head}${fixed ?? value.trim()}${tail}`;
		},
	);

	next = next.replace(
		/^(- \*\*Time:\*\* )([^(\n]+?)(\s*\()/m,
		(_m, head, value, tail) => {
			const fixed = normalizeTimes(value.trim());
			if (fixed && fixed !== value.trim()) notes.push("end time");
			return `${head}${fixed ?? value.trim()}${tail}`;
		},
	);

	if (!notes.length) continue;

	// Visible, dated, and inside the body — not hidden in the footer.
	//
	// The wording states only what was actually wrong in THIS post. A generic
	// note claiming both defects would assert an error the file never had, which
	// is precisely the kind of unsupported statement this project exists to
	// prevent — in a correction notice of all places.
	const what = [];
	if (notes.includes("end time")) {
		what.push("showed this meeting ending at 11:59 PM");
	}
	if (notes.includes("address")) {
		what.push("ran the street and city together in the location");
	}
	const plural = what.length > 1;
	const correction =
		`\n*Correction, ${CORRECTION_DATE}: an earlier version of this preview ` +
		`${what.join(" and ")}. ${plural ? "Those were artifacts" : "That was an artifact"} ` +
		`of the city calendar feed's own formatting, ` +
		`not ${plural ? "facts" : "a fact"} about the meeting.*\n`;

	if (!next.includes("*Correction,")) {
		const footer = next.lastIndexOf("\n---\n");
		next =
			footer > 0
				? next.slice(0, footer) + "\n" + correction + next.slice(footer)
				: next + correction;
	}

	changed.push({ file, notes: [...new Set(notes)], next, path });
}

console.log(`preview posts corrected: ${changed.length}`);
for (const c of changed) console.log(`  ${c.file} — ${c.notes.join(", ")}`);

if (!apply) {
	if (changed[0]) {
		console.log("\n--- sample diff of the first file ---");
		const before = readFileSync(changed[0].path, "utf8").split("\n");
		const after = changed[0].next.split("\n");
		for (let i = 0; i < Math.max(before.length, after.length); i++) {
			if (before[i] !== after[i]) {
				if (before[i] !== undefined) console.log(`  - ${before[i]}`);
				if (after[i] !== undefined) console.log(`  + ${after[i]}`);
			}
		}
	}
	console.log("\nDry run. Re-run with --apply to write.");
	process.exit(0);
}

for (const c of changed) writeFileSync(c.path, c.next);
console.log(`\nWrote ${changed.length} file(s).`);
