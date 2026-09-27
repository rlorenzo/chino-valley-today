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
// invent one. A person pulls the minutes through a browser, which robots.txt
// does not govern, and drops them in DROP_DIR. This ingests what it finds.
//
// Either form is accepted: the PDF, or the text of WebLink's "View plain text"
// mode saved as .txt (pages separated by "-- N of M --", the same marker
// pdf-parse emits). The text is what the pipeline uses either way, and the
// site never serves the minutes file itself -- citations link to the portal.
//
// If the City ever grants access (the request is drafted; City Clerk,
// 909-364-2620, cityclerk@chinohills.org), a fetch step can be added in front
// of the parse below and everything downstream of it stays as written.
//
// FILE NAMING
//
// Files must be named:  chinohills-<body>-<YYYY-MM-DD>-minutes.(pdf|txt)
// e.g.                  chinohills-city-council-2026-08-11-minutes.txt
//
// The name carries the body and the meeting date because the drop is the only
// place that information reliably exists: WebLink's own filenames are
// inconsistent across bodies, and a PDF's internal text does not always state
// its body. The date IS cross-checked against the document text below, and a
// mismatch fails the file rather than guessing.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { extractPdfText, type PdfText } from "../pdf.ts";
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

const FILENAME_RE =
	/^chinohills-([a-z-]+?)-(\d{4}-\d{2}-\d{2})-minutes\.(pdf|txt)$/i;
const NAME_SHAPE = "chinohills-<body>-<YYYY-MM-DD>-minutes.(pdf|txt)";

export interface ParsedName {
	bodySlug: string;
	bodyName: string;
	minutesUrl: string;
	date: string;
	ext: "pdf" | "txt";
}

// Returns the parsed name, or a string explaining why it is unusable. Callers
// treat the string as a rejection reason, never as a parse.
export function parseFilename(filename: string): ParsedName | string {
	const m = filename.match(FILENAME_RE);
	if (!m) {
		return `filename does not match ${NAME_SHAPE}`;
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
	return {
		bodySlug,
		bodyName: body.name,
		minutesUrl: body.minutesUrl,
		date,
		ext: m[3].toLowerCase() as "pdf" | "txt",
	};
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

const PAGE_MARKER = /^-- \d+ of \d+ --$/;

// The text of a dropped file, or a string explaining why it is unusable.
// An HTML error page or a truncated download saved under the right name is the
// most likely bad input here, and it would otherwise reach the parse as a
// confusing error or, for .txt, as "text".
export async function readMinutesText(
	bytes: Buffer,
	ext: ParsedName["ext"],
): Promise<PdfText | string> {
	if (ext === "txt") {
		const text = bytes.toString("utf8");
		if (/^\s*</.test(text.slice(0, 200))) {
			return "looks like HTML, not the minutes text (a saved error page?)";
		}
		const numPages = text
			.split("\n")
			.filter((l) => PAGE_MARKER.test(l.trim())).length;
		return { text, numPages: numPages || 1 };
	}
	if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
		return "not a PDF (no %PDF- header; a saved error page or a truncated download?)";
	}
	try {
		return await extractPdfText(bytes);
	} catch (err) {
		return `PDF text extraction failed (${err})`;
	}
}

// A trailing video timestamp on a heading: "CONSENT CALENDAR [18:31]".
const VIDEO_TS = /\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]$/;

export interface MinutesItem {
	num: number;
	title: string;
	body: string;
	/** Offset into the meeting video, as printed: "[18:31]" -> "18:31". */
	videoOffset: string | null;
}

// Splits minutes text into items at their ALL-CAPS headings.
//
// Chino Hills minutes are not numbered. Validated against the real City
// Council minutes of 2026-08-11 (the first one pulled, 2026-09-26): every item
// is an upper-case heading line, often ending in a video timestamp --
// "PROCLAMATION - NATIONAL CRIME PREVENTION WEEK [12:03]", "CONSENT CALENDAR
// [18:31]" -- and each consent item is its own heading ("PAYMENT REGISTER")
// with a paragraph recording the action. The numbered-item splitter this
// replaces had been built on synthetic fixtures and found nothing in it.
//
// A heading is an all-caps line that carries a video timestamp or is followed
// by ordinary prose, and is not a labelled line ("PRESENT:", "AYES:" -- rosters
// and votes stay in the body) or a bullet ("• TEEN ACTIVITY CENTER" is a
// sub-point). A single-word heading, or one under a line ending in "-", is a
// wrap and takes the line above. A heading with no text under it is dropped.
//
// Parsing stops at "Respectfully submitted": after it come the clerk's
// signature and, on DocuSigned minutes, the envelope certificate, which
// carries a staff email and IP address and is nobody's agenda item.
export function extractMinutesItems(rawText: string): MinutesItem[] {
	const end = rawText.search(/^[ \t]*Respectfully submitted/im);
	// Body name ("PARKS & RECREATION COMMISSION") and minute-book page number.
	const runningHeader = /^[A-Z][A-Z &]+ \d{4}-\d{1,4}$/;
	const lines = (end >= 0 ? rawText.slice(0, end) : rawText)
		.split("\n")
		.map((l) => l.trim())
		// Page furniture: page markers, the running header ("CHINO HILLS CITY
		// COUNCIL 2026-156" over "REGULAR MEETING..."), DocuSign stamps.
		.filter(
			(l, i, all) =>
				!PAGE_MARKER.test(l) &&
				!/^Docusign Envelope ID:/i.test(l) &&
				!runningHeader.test(l) &&
				!(runningHeader.test(all[i - 1] ?? "") && /MEETING/.test(l)),
		);

	const isCaps = (l: string) => /[A-Z]{3}/.test(l) && l === l.toUpperCase();
	// Roster and vote labels; any other colon ("PUBLIC HEARING: ...") can sit in
	// a heading.
	const isLabel = (l: string) =>
		/^(ALSO PRESENT|PRESENT|ABSENT|AYES|NOES|ABSTAIN|ABSTAINED|RECUSED)\s*:/.test(
			l,
		);
	// Blank lines are not a signal: WebLink's text layer keeps them on some
	// documents (2026-08-11) and drops every one on others (2026-01-13). So
	// they go, and a heading is found by what follows it instead.
	const text = lines.filter((l) => l !== "");
	// The masthead runs down to its "REGULAR MEETING" line.
	const mastEnd = text
		.slice(0, 15)
		.findIndex((l) => /^(REGULAR|SPECIAL|ADJOURNED|JOINT)\b.*MEETING$/.test(l));
	const body = mastEnd >= 0 ? text.slice(mastEnd + 1) : text;

	const candidate = (l: string | undefined) =>
		l !== undefined && isCaps(l) && !isLabel(l) && !/^[•o] /.test(l);
	// Prose starts with a mixed-case word ("Mayor Johsz called...", "• Fall
	// Recreation..."); "RAY MARQUEZ (attended remotely)" is still a roster line.
	const isProse = (l: string | undefined) =>
		l !== undefined && /^(?:[•o]\s+)?\S*[a-z]/.test(l);
	// A heading is a caps line with a timestamp, or one followed by prose. A
	// roster name is followed by the next name, so it never qualifies.
	const isHeading = (k: number) =>
		candidate(body[k]) && (VIDEO_TS.test(body[k]) || isProse(body[k + 1]));

	const sections: Array<{ heading: string; body: string[] }> = [];
	let current: { heading: string; body: string[] } | null = null;
	for (let k = 0; k < body.length; k++) {
		const l = body[k];
		if (isHeading(k)) {
			let heading = l;
			// A wrapped heading: "... - RESOLUTIONS" / "ADOPTED",
			// "... PUMP ON-" / "CALL MAINTENANCE". Take the line above back
			// from the previous section's body.
			const prev = body[k - 1];
			if (
				candidate(prev) &&
				!isHeading(k - 1) &&
				(prev.endsWith("-") || !/\s/.test(l.replace(VIDEO_TS, "")))
			) {
				heading = `${prev} ${l}`;
				current?.body.pop();
			}
			current = { heading, body: [] };
			sections.push(current);
			continue;
		}
		if (current) current.body.push(l);
	}

	return sections
		.filter((sec) => sec.body.length > 0)
		.map((sec, i) => {
			const ts = sec.heading.match(VIDEO_TS);
			return {
				num: i + 1,
				title: (ts ? sec.heading.slice(0, ts.index) : sec.heading).slice(
					0,
					120,
				),
				body: sec.body.join(" ").replace(/\s+/g, " ").trim(),
				videoOffset: ts ? ts[1] : null,
			};
		});
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

const scraper: ScraperDef = {
	key: "chinohills-minutes",
	name: "Chino Hills meeting minutes (hand-dropped PDF or text)",
	baseUrl: "https://publicportal.chinohills.org",
	method: "pdf",
	async run(ctx: ScraperContext) {
		const dir = dropDir();
		let filenames: string[];
		try {
			filenames = readdirSync(dir)
				.filter((f) => /\.(pdf|txt)$/i.test(f))
				.sort();
		} catch {
			// A missing drop directory is the normal state on a machine nobody has
			// dropped files on. It is not a failure, and must not be reported as
			// one, but it IS worth saying out loud so an operator who expected
			// files knows where they were looked for.
			ctx.note(
				`No drop directory at ${dir} — nothing to ingest. Create it and add ` +
					`files named ${NAME_SHAPE}.`,
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
			// A bad file is never archived, so it cannot match a held hash and
			// always reaches the check in readMinutesText.
			if (seenHash.get(sha256(bytes))) {
				skipped++;
				continue;
			}

			const read = await readMinutesText(bytes, parsed.ext);
			if (typeof read === "string") {
				rejected.push(`${filename}: ${read}`);
				continue;
			}
			const { text, numPages } = read;

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
				ext: parsed.ext,
				title,
				meetingDate: parsed.date,
			});
			ingested++;

			const items = extractMinutesItems(text);
			if (items.length === 0) {
				ctx.note(
					`${filename}: archived (${numPages} pages) but no items were ` +
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
						videoOffset: item.videoOffset,
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
			`Drop ingest from ${dir}: ${filenames.length} file(s) present, ${ingested} newly ` +
				`archived, ${skipped} already held (content hash matched an existing document), ` +
				`${itemsInserted} new item(s), ${rejected.length} rejected.`,
		);
		ctx.note(
			"Scope: this archives minutes and splits them into items at their headings. It does " +
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
