// Chino Hills meeting MINUTES, ingested from a local drop directory rather
// than fetched.
//
// WHY THIS SCRAPER DOES NOT FETCH ANYTHING
//
// Chino Hills publishes minutes only through Laserfiche WebLink at
// publicportal.chinohills.org. That host's robots.txt is well formed and
// explicit:
//
//   User-agent: *
//   Crawl-delay: 2000
//   Disallow: /Weblink/
//   Disallow: /*.aspx
//
// `Disallow: /*.aspx` covers every Browse.aspx and DocView.aspx URL the system
// uses, which is all of them. reports/notes/chinohills.md (headline finding,
// and again at the "Laserfiche WebLink" bullet) records the same conclusion
// from Task 0.4, including that no REST API exists to justify skipRobots:
// /WebLink/api/entry/<id> and /api/entry/<id> both 404. AgendaQuick, which
// serves the agendas, has no minutes at all: the template's "Minutes" slot was
// empty in every meeting sampled across August, June and February 2026.
//
// So there is no permitted automated path to minutes, and this scraper does not
// invent one. A person downloads the PDFs through a browser, which robots.txt
// does not govern, and drops them in DROP_DIR. This ingests what it finds.
//
// If the City ever grants access (the request is drafted; City Clerk,
// 909-364-2620, cityclerk@chinohills.org), a fetch step can be added in front
// of the parse below and everything downstream of it stays as written.
//
// FILE NAMING
//
// Files must be named:  chinohills-<body>-<YYYY-MM-DD>-minutes.pdf
// e.g.                  chinohills-city-council-2026-08-11-minutes.pdf
//
// The name carries the body and the meeting date because the drop is the only
// place that information reliably exists: WebLink's own filenames are
// inconsistent across bodies, and a PDF's internal text does not always state
// its body. The date IS cross-checked against the document text below, and a
// mismatch fails the file rather than guessing.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { extractPdfText } from "../pdf.ts";
import type { ScraperContext, ScraperDef } from "./types.ts";

const repoRoot = join(import.meta.dirname, "..", "..");

// Overridable so the test can point at a fixture directory; production uses
// the default. Relative values resolve against the repo root, not the process
// working directory, so a run from anywhere finds the same drop.
function dropDir(): string {
	const configured =
		process.env.CVT_MINUTES_DROP_DIR ?? "data/incoming/chinohills-minutes";
	return isAbsolute(configured) ? configured : join(repoRoot, configured);
}

// The eight bodies, each with the Laserfiche folder a reader should open. These
// URLs are recorded on items and documents as the reader-facing link; nothing
// here ever requests them. Read off www.chinohills.org/60/Agendas-Minutes,
// which is not robots-blocked.
const BODIES: Record<string, { name: string; minutesUrl: string }> = {
	"city-council": {
		name: "City Council",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?startid=66925",
	},
	"parks-recreation-commission": {
		name: "Parks & Recreation Commission",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?id=175253&dbid=0&repo=CoCH",
	},
	"planning-commission": {
		name: "Planning Commission",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?id=3943&dbid=0&repo=CoCH",
	},
	"public-works-commission": {
		name: "Public Works Commission",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?id=303105&dbid=0&repo=CoCH",
	},
	"deferred-compensation-committee": {
		name: "Employee Deferred Compensation Committee",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?id=341392&dbid=0&repo=CoCH",
	},
	"legislative-advocacy-committee": {
		name: "Legislative Advocacy Committee",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?id=150216&dbid=0&repo=CoCH",
	},
	"public-art-committee": {
		name: "Public Art Committee",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?id=348679&dbid=0&repo=CoCH",
	},
	"tres-hermanos-jpa": {
		name: "Tres Hermanos JPA",
		minutesUrl:
			"https://publicportal.chinohills.org/WebLink/Browse.aspx?id=220589&dbid=0&repo=CoCH",
	},
};

const FILENAME_RE = /^chinohills-([a-z-]+?)-(\d{4}-\d{2}-\d{2})-minutes\.pdf$/i;

export interface ParsedName {
	bodySlug: string;
	bodyName: string;
	minutesUrl: string;
	date: string;
}

// Returns the parsed name, or a string explaining why it is unusable. Callers
// treat the string as a rejection reason, never as a parse.
export function parseFilename(filename: string): ParsedName | string {
	const m = filename.match(FILENAME_RE);
	if (!m) {
		return `filename does not match chinohills-<body>-<YYYY-MM-DD>-minutes.pdf`;
	}
	const bodySlug = m[1].toLowerCase();
	const body = BODIES[bodySlug];
	if (!body) {
		return `unknown body "${bodySlug}"; known bodies: ${Object.keys(BODIES).join(", ")}`;
	}
	const date = m[2];
	// Reject a date the calendar does not have (2026-02-31) rather than let it
	// through to occurred_at, where it would silently sort wrong forever.
	const [y, mo, d] = date.split("-").map(Number);
	const asDate = new Date(Date.UTC(y, mo - 1, d));
	if (
		asDate.getUTCFullYear() !== y ||
		asDate.getUTCMonth() !== mo - 1 ||
		asDate.getUTCDate() !== d
	) {
		return `"${date}" is not a real calendar date`;
	}
	return { bodySlug, bodyName: body.name, minutesUrl: body.minutesUrl, date };
}

// Does the document text corroborate the date the filename claims? Minutes
// state their meeting date on the first page in one of a few long forms
// ("August 11, 2026" / "11 August 2026"). A file whose text names a DIFFERENT
// date than its filename is a mis-rename, and mis-filed minutes are worse than
// absent ones: they attach the wrong record to a meeting. Absence of any date
// in the text is not evidence of a mismatch (scanned minutes OCR poorly), so
// that case passes with a note rather than failing.
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

export function dateCorroboration(
	text: string,
	expected: string,
): { ok: boolean; found: string[] } {
	const head = text.slice(0, 4000).toLowerCase();
	const found = new Set<string>();
	// "August 11, 2026" and "11 August 2026", both with flexible whitespace.
	const mdY = /([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/g;
	const dMY = /(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})/g;
	for (const m of head.matchAll(mdY)) {
		const mi = MONTHS.indexOf(m[1]);
		if (mi >= 0) {
			found.add(
				`${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`,
			);
		}
	}
	for (const m of head.matchAll(dMY)) {
		const mi = MONTHS.indexOf(m[2]);
		if (mi >= 0) {
			found.add(
				`${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`,
			);
		}
	}
	const list = [...found];
	// No date read at all: cannot corroborate, cannot contradict.
	if (list.length === 0) return { ok: true, found: list };
	return { ok: list.includes(expected), found: list };
}

export interface MinutesItem {
	num: number;
	title: string;
	body: string;
}

// Splits minutes text into numbered items.
//
// CONSERVATIVE ON PURPOSE, AND PROVISIONAL.
//
// Distinguishing a top-level item from a numbered list INSIDE one (a motion's
// conditions, findings in a resolution) is genuinely ambiguous once a PDF is
// flattened to text: both are "N." at the start of a line. A first attempt here
// kept any increasing number and duly turned the "2." of a nested list into a
// spurious top-level item, because it followed a kept "1.".
//
// So this uses the same rule chinohills-agendas.ts uses: a numbered line counts
// only while the sequence runs 1, 2, 3, ... incrementing by exactly one, and the
// scan stops at the first break. It reaches that rule by a different route --
// the agenda splitter needs it to find the boundary where a packet's backup
// materials begin, while minutes have no backup materials and need it to avoid
// nested lists -- which is why the two are not shared: same rule today, but they
// would drift for unrelated reasons, and a shared helper would hide that.
//
// The cost is under-extraction: minutes that restart numbering per section stop
// at the first restart. That is the right way to be wrong here. A missing item
// is a gap in the breakdown, while a fabricated one is a false entry in a record
// whose whole promise is that every claim traces to a source.
//
// NOT YET VALIDATED against a real Chino Hills minutes PDF -- there is no
// permitted way to fetch one (see the header), so this was built against
// synthetic fixtures. The first real drop should be checked by eye: compare the
// item count and titles this produces against the document. The document itself
// is archived and linked regardless of how this does, so a poor split degrades
// the breakdown, never the record.
export function extractMinutesItems(rawText: string): MinutesItem[] {
	const text = rawText
		// pdf-parse page-boundary markers and bare page-number lines.
		.replace(/^-- \d+ of \d+ --[ \t]*$/gm, "")
		.replace(/^\d{1,4}\/\d{1,4}[ \t]*$/gm, "");
	const matches: Array<{ num: number; start: number; end: number }> = [];
	for (const m of text.matchAll(/^(\d{1,3})\.[ \t]+/gm)) {
		matches.push({
			num: parseInt(m[1], 10),
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	const kept: typeof matches = [];
	for (const m of matches) {
		const prev = kept[kept.length - 1];
		if (!prev && m.num === 1) kept.push(m);
		else if (prev && m.num === prev.num + 1) kept.push(m);
		else if (prev) break;
	}
	return kept.map((m, i) => {
		const stop = i + 1 < kept.length ? kept[i + 1].start : text.length;
		const chunk = text.slice(m.end, stop);
		const firstLine =
			chunk
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.length > 0) ?? "";
		return {
			num: m.num,
			title: firstLine.slice(0, 120),
			body: chunk.replace(/\s+/g, " ").trim(),
		};
	});
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

const scraper: ScraperDef = {
	key: "chinohills-minutes",
	name: "Chino Hills meeting minutes (hand-dropped PDFs)",
	baseUrl: "https://publicportal.chinohills.org",
	method: "pdf",
	async run(ctx: ScraperContext) {
		const dir = dropDir();
		let filenames: string[];
		try {
			filenames = readdirSync(dir)
				.filter((f) => f.toLowerCase().endsWith(".pdf"))
				.sort();
		} catch {
			// A missing drop directory is the normal state on a machine nobody has
			// dropped files on. It is not a failure, and must not be reported as
			// one, but it IS worth saying out loud so an operator who expected
			// files knows where they were looked for.
			ctx.note(
				`No drop directory at ${dir} — nothing to ingest. Create it and add ` +
					"files named chinohills-<body>-<YYYY-MM-DD>-minutes.pdf.",
			);
			return;
		}

		if (filenames.length === 0) {
			ctx.note(
				`Drop directory ${dir} is empty — nothing to ingest. This is the ` +
					"expected state between hand-pulls; minutes appear days after a meeting.",
			);
			return;
		}

		// Content-addressed skip. Re-running over a drop directory that has not
		// changed must not re-parse every PDF in it, and the file's hash answers
		// that without opening the document. Cheap read, expensive parse avoided.
		const seenHash = ctx.db.raw.prepare(
			"SELECT id FROM documents WHERE content_hash = ? LIMIT 1",
		);

		const rejected: string[] = [];
		let ingested = 0;
		let skipped = 0;
		let itemsInserted = 0;

		for (const filename of filenames) {
			const parsed = parseFilename(filename);
			if (typeof parsed === "string") {
				rejected.push(`${filename}: ${parsed}`);
				continue;
			}

			const bytes = readFileSync(join(dir, filename));
			// An HTML error page or a truncated download saved with a .pdf name is
			// the most likely bad input here, and it would otherwise reach
			// extractPdfText as a confusing parser error.
			if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
				rejected.push(
					`${filename}: not a PDF (no %PDF- header; a saved error page or a truncated download?)`,
				);
				continue;
			}

			if (seenHash.get(sha256(bytes))) {
				skipped++;
				continue;
			}

			let text: string;
			let numPages: number;
			try {
				const out = await extractPdfText(bytes);
				text = out.text;
				numPages = out.numPages;
			} catch (err) {
				rejected.push(`${filename}: PDF text extraction failed (${err})`);
				continue;
			}

			const corroboration = dateCorroboration(text, parsed.date);
			if (!corroboration.ok) {
				rejected.push(
					`${filename}: filename says ${parsed.date} but the document text reads ` +
						`${corroboration.found.join(", ")} — refusing to file minutes under the wrong meeting`,
				);
				continue;
			}
			if (corroboration.found.length === 0) {
				ctx.note(
					`${filename}: no date found in the document text (scanned or image-only ` +
						`minutes?), so ${parsed.date} rests on the filename alone.`,
				);
			}

			const title = `${parsed.bodyName} — minutes, ${parsed.date}`;
			const { documentId } = ctx.ingestLocal(bytes, {
				url: parsed.minutesUrl,
				docType: "minutes",
				ext: "pdf",
				title,
				meetingDate: parsed.date,
			});
			ingested++;

			const items = extractMinutesItems(text);
			if (items.length === 0) {
				ctx.note(
					`${filename}: archived (${numPages} pages) but no numbered items were ` +
						"parsed from it — the document is stored and linked, with no item breakdown.",
				);
			}
			for (const item of items) {
				const r = ctx.insertItem({
					document_id: documentId,
					source_url: parsed.minutesUrl,
					item_type: "agenda_item",
					external_id: `${parsed.bodySlug}-${parsed.date}-${item.num}`,
					title: item.title || `Item ${item.num}`,
					body: item.body,
					occurred_at: parsed.date,
					meta: {
						body: parsed.bodyName,
						bodySlug: parsed.bodySlug,
						itemNumber: item.num,
						// Distinguishes an outcome recorded in minutes from the same
						// item as it appeared on the agenda beforehand.
						record: "minutes",
						sourceFile: filename,
					},
				});
				if (r.isNew) itemsInserted++;
			}
		}

		ctx.note(
			`Drop ingest from ${dir}: ${filenames.length} PDF(s) present, ${ingested} newly ` +
				`archived, ${skipped} already held (content hash matched an existing document), ` +
				`${itemsInserted} new item(s), ${rejected.length} rejected.`,
		);
		ctx.note(
			"Scope: this archives minutes and splits them into numbered items. It does " +
				"NOT extract votes or roll calls — recorded votes are the obvious next " +
				"step and deliberately out of scope here, since a mis-parsed vote is a " +
				"factual error in the record rather than a missing one.",
		);

		// Rejections fail the run. A drop-directory source that quietly skipped
		// bad files would report success while ingesting nothing, which is exactly
		// how chinohills-swagit hid a six-day outage: it noted its failed listing
		// probe and returned normally, so run-one.ts recorded status 'success'
		// with 0 items every day and no watchdog could see it.
		if (rejected.length > 0) {
			throw new Error(
				`${rejected.length} file(s) rejected from ${dir}:\n  ${rejected.join("\n  ")}`,
			);
		}
	},
};

export default scraper;
