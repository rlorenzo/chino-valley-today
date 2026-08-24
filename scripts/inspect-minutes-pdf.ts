// Reads a downloaded minutes PDF and proposes the canonical drop filename.
//
// The drop directory's contract is that the filename carries the body and the
// meeting date (see src/scrapers/chinohills-minutes.ts). WebLink's own
// filenames do not reliably carry either, so this reads the document's first
// page and proposes a name from what it actually says. It PROPOSES only:
// mis-filing minutes under the wrong meeting is a false entry in the record,
// so a person confirms before anything is renamed.
//
// Usage: node scripts/inspect-minutes-pdf.ts <file.pdf> [<file.pdf> ...]
// Prints one JSON object per line: { file, date, body, suggested, confidence }.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { extractPdfText } from "../src/pdf.ts";

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

// Longest names first: "public works commission" must win over a bare
// "commission", and "city council" must not match inside "city council
// chambers" ambiguously.
const BODY_PATTERNS: Array<[RegExp, string]> = [
	[/employee\s+deferred\s+compensation/i, "deferred-compensation-committee"],
	[/legislative\s+advocacy/i, "legislative-advocacy-committee"],
	[/parks\s*(&|and)\s*recreation/i, "parks-recreation-commission"],
	[/public\s+works\s+commission/i, "public-works-commission"],
	[/public\s+art\s+committee/i, "public-art-committee"],
	[/tres\s+hermanos/i, "tres-hermanos-jpa"],
	[/planning\s+commission/i, "planning-commission"],
	[/city\s+council/i, "city-council"],
];

function findDate(head: string): string | null {
	const lower = head.toLowerCase();
	const dates: string[] = [];
	for (const m of lower.matchAll(/([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/g)) {
		const mi = MONTHS.indexOf(m[1]);
		if (mi >= 0) {
			dates.push(
				`${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`,
			);
		}
	}
	for (const m of lower.matchAll(/(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})/g)) {
		const mi = MONTHS.indexOf(m[2]);
		if (mi >= 0) {
			dates.push(
				`${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`,
			);
		}
	}
	// The meeting date is the first one printed; later dates in minutes are
	// usually references to other meetings or deadlines.
	return dates[0] ?? null;
}

function findBody(head: string): string | null {
	for (const [re, slug] of BODY_PATTERNS) if (re.test(head)) return slug;
	return null;
}

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: node scripts/inspect-minutes-pdf.ts <file.pdf> ...");
	process.exit(64);
}

for (const file of files) {
	const out: Record<string, unknown> = { file: basename(file) };
	try {
		const bytes = readFileSync(file);
		if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
			out.error = "not a PDF (no %PDF- header)";
			console.log(JSON.stringify(out));
			continue;
		}
		const { text, numPages } = await extractPdfText(bytes);
		const head = text.slice(0, 4000);
		const date = findDate(head);
		const body = findBody(head);
		out.pages = numPages;
		out.date = date;
		out.body = body;
		out.looksLikeMinutes = /minutes/i.test(head);
		out.suggested =
			date && body ? `chinohills-${body}-${date}-minutes.pdf` : null;
		// Everything the proposal rests on, so a reviewer can judge it without
		// opening the PDF.
		out.confidence =
			date && body && out.looksLikeMinutes
				? "high"
				: date && body
					? "medium (document text does not say 'minutes')"
					: "low (could not read date and/or body from the text)";
		out.firstLines = head
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.slice(0, 6);
	} catch (err) {
		out.error = String(err);
	}
	console.log(JSON.stringify(out));
}
