// Post type 3: business tracker. ONE post per ISO week listing abc-licenses
// license_event items from the last 14 days, verbatim fields from meta, each
// entry linking its own source_url.
import type { Db } from "../db/index.ts";
import type { NewPost } from "../pipeline/posts.ts";
import { archiveUrl, licenseRowAnchor } from "../pipeline/site-url.ts";
import { type ItemRow, parseMeta, queryItems } from "./queries.ts";
import { isoWeekForNow, mdEscape, mdLink, withinLastDays } from "./util.ts";

interface GenResult {
	posts: NewPost[];
	notes: string[];
}

const WINDOW_DAYS = 14;

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * THE CITATION IS THE ARCHIVE PAGE, not row.source_url.
 *
 * row.source_url is the daily report page, which is not date-stable: fetched
 * with no query string it renders whatever report abc.ca.gov currently treats
 * as current, and any query string is 301-stripped at the edge, so there is no
 * per-report and no per-licence URL to point at. A tracker published on Tuesday
 * cited a page that by Wednesday showed a different day entirely — the records
 * it described were simply gone.
 *
 * /source/<sha256>/#row-<n> serves the archived report this entry was read
 * from, extracted to the local rows and rendered for a person, with the live
 * abc.ca.gov page linked from it as the authority.
 */
function citationFor(row: ItemRow, meta: Record<string, unknown>): string {
	return archiveUrl(row.doc_content_hash, licenseRowAnchor(meta.row_index));
}

function fmtLicenseLine(row: ItemRow): string {
	const meta = parseMeta(row.meta);
	const primaryName = str(meta.primary_name);
	const dba = str(meta.dba);
	const name = primaryName ?? dba ?? "Unknown";
	const dbaSuffix = dba && dba !== name ? ` (dba ${mdEscape(dba)})` : "";
	const licenseType = str(meta.license_type);
	const address = str(meta.premises_address);
	const status = str(meta.status);
	const reportType =
		meta.report_type === "new_applications"
			? "New application"
			: "Status change";

	const parts = [`**${mdEscape(name)}**${dbaSuffix}`, reportType];
	if (licenseType) parts.push(`Type ${mdEscape(licenseType)}`);
	if (status) parts.push(mdEscape(status));
	if (address) parts.push(mdEscape(address));

	return `- ${parts.join(" — ")} — ${mdLink("source", citationFor(row, meta))}`;
}

export function generateBusinessTracker(db: Db, now: Date): GenResult {
	const items = queryItems(db, {
		sourceKeys: ["abc-licenses"],
		itemTypes: ["license_event"],
	});
	const inWindow = items.filter((r) =>
		withinLastDays(r.occurred_at, now, WINDOW_DAYS),
	);
	const notes: string[] = [];
	const posts: NewPost[] = [];

	if (inWindow.length === 0) {
		notes.push(
			`0 license_event item(s) in the last ${WINDOW_DAYS} days (${items.length} total in DB) — skipped.`,
		);
		return { posts, notes };
	}

	const week = isoWeekForNow(now);
	const byDate = new Map<string, ItemRow[]>();
	for (const row of inWindow) {
		const key = row.occurred_at ?? "unknown date";
		const arr = byDate.get(key) ?? [];
		arr.push(row);
		byDate.set(key, arr);
	}
	const dates = [...byDate.keys()].sort().reverse();
	const sections = dates.map((date) =>
		[`### ${date}`, "", ...(byDate.get(date) ?? []).map(fmtLicenseLine)].join(
			"\n",
		),
	);
	// One entry per archived report, not per row: a source is a document, and
	// listing the same report once per licence would inflate the source count
	// the inspection record shows.
	const sources = [
		...new Set(inWindow.map((r) => archiveUrl(r.doc_content_hash))),
	];

	posts.push({
		slug: `${week}-business-tracker`,
		postType: "business_tracker",
		tier: "A",
		title: `Business License Tracker — ${week}`,
		bodyMd: sections.join("\n\n"),
		sources,
		sourceKeys: [...new Set(inWindow.map((r) => r.source_key))],
		itemTypes: [...new Set(inWindow.map((r) => r.item_type))],
	});

	notes.push(
		`${inWindow.length} license_event item(s) in the last ${WINDOW_DAYS} days -> 1 business_tracker post (${week}).`,
	);
	return { posts, notes };
}
