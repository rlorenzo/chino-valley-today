// Phase 4 Task 4.1 — shared plumbing for the four Tribe Events Calendar sources
// (sbclib-events, sbparks-events, cbwcd-events, yanksair-events). All four run
// WordPress + The Events Calendar, whose REST API is public JSON with stable
// per-event permalinks — verified per-host on 2026-08-17 (see PLAN.md Phase 4
// Task 4.0 and each source's dossier in reports/notes/).
//
// API shape: GET /wp-json/tribe/events/v1/events?start_date=YYYY-MM-DD
//   &per_page=N&page=N[&venue=<id>] -> { events: [...], total, total_pages }.
// Recurring events return one entry per occurrence; occurrence ids were not
// verified to be globally unique across occurrences, so external_id is
// `<id>:<utc_start_date>` — stable under either id behaviour.
import { stripHtml } from "./civicplus-rss.ts";
import { resolveDocumentId } from "./document-linkage.ts";
import type { NewItemInput, ScraperContext } from "./types.ts";

export interface TribeEvent {
	id: number;
	url: string;
	title?: string;
	description?: string;
	// "YYYY-MM-DD HH:MM:SS", already UTC per the API contract.
	utc_start_date?: string;
	utc_end_date?: string;
	all_day?: boolean;
	cost?: string;
	venue?: { id?: number; venue?: string };
	categories?: Array<{ name?: string }>;
}

export interface TribeSourceConfig {
	host: string; // e.g. "library.sbcounty.gov" — no scheme, no path
	// Venue ids to query one by one; omit to take the host's whole calendar
	// (appropriate when the whole institution is Chino Valley-local).
	venues?: Array<{ id: number; label: string }>;
	// Look back this many days so late-morning runs still capture today's
	// already-started events. Default 1.
	lookbackDays?: number;
	// Pagination cap per query; 50/page. Default 3 (150 events) — plenty for a
	// daily brief window and keeps runs polite.
	maxPages?: number;
	// Extra delay between requests beyond politeFetch's 2s/host floor, for hosts
	// whose robots.txt requests a longer Crawl-delay (yanksair.org asks for 10).
	extraRequestGapMs?: number;
}

// "2026-08-16 21:00:00" (UTC by contract) -> "2026-08-16T21:00:00.000Z".
export function tribeUtcToIso(s: string | undefined): string | null {
	if (!s) return null;
	const d = new Date(`${s.replace(" ", "T")}Z`);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Today's date in America/Los_Angeles minus lookbackDays, as YYYY-MM-DD.
// Takes `now` explicitly so tests are deterministic. Calendar-day arithmetic
// (LA date first, then subtract days) rather than a fixed 86400s offset — a
// 23/25-hour DST day plus a near-midnight run could otherwise shift the
// window start by a day (review finding, PR #12).
export function laStartDate(now: Date, lookbackDays: number): string {
	const la = new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now); // en-CA formats as YYYY-MM-DD
	const [y, m, d] = la.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d - lookbackDays))
		.toISOString()
		.slice(0, 10);
}

// Pure mapping from an API event to an item, exported for tests. Titles and
// descriptions carry HTML entities/markup (&#8211; etc.); stripHtml decodes.
export function tribeEventToItem(
	e: TribeEvent,
	host: string,
	venueLabel?: string,
): Omit<NewItemInput, "document_id"> {
	return {
		source_url: e.url,
		item_type: "event",
		external_id: `${e.id}:${e.utc_start_date ?? ""}`,
		title: stripHtml(e.title) || `(untitled event ${e.id})`,
		body: stripHtml(e.description) || null,
		occurred_at: tribeUtcToIso(e.utc_start_date),
		meta: {
			host,
			venue: e.venue?.venue ?? venueLabel ?? null,
			venueId: e.venue?.id ?? null,
			categories: (e.categories ?? [])
				.map((c) => c.name)
				.filter((n): n is string => !!n),
			cost: e.cost || null,
			endUtc: tribeUtcToIso(e.utc_end_date),
			allDay: e.all_day ?? false,
		},
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTribeEvents(
	ctx: ScraperContext,
	cfg: TribeSourceConfig,
): Promise<void> {
	const startDate = laStartDate(new Date(), cfg.lookbackDays ?? 1);
	const maxPages = cfg.maxPages ?? 3;
	const queries = cfg.venues?.length
		? cfg.venues.map((v) => ({ venue: v, qs: `&venue=${v.id}` }))
		: [{ venue: undefined, qs: "" }];

	let first = true;
	for (const q of queries) {
		let page = 1;
		let totalPages = 1;
		let stored = 0;
		let reportedTotal: number | undefined;
		while (page <= totalPages && page <= maxPages) {
			if (!first && cfg.extraRequestGapMs) await sleep(cfg.extraRequestGapMs);
			first = false;
			const url =
				`https://${cfg.host}/wp-json/tribe/events/v1/events` +
				`?start_date=${startDate}&per_page=50&page=${page}${q.qs}`;
			const doc = await ctx.fetchDocument(url, {
				docType: "feed",
				title: `Tribe events — ${cfg.host}${q.venue ? ` — ${q.venue.label}` : ""} — p${page}`,
			});
			let parsed: {
				events?: TribeEvent[];
				total?: number;
				total_pages?: number;
			};
			try {
				parsed = JSON.parse(doc.body.toString("utf8"));
			} catch (err) {
				ctx.note(
					`Tribe API response at ${url} failed to parse as JSON: ${(err as Error).message}`,
				);
				break;
			}
			totalPages = parsed.total_pages ?? 1;
			reportedTotal = parsed.total;
			for (const e of parsed.events ?? []) {
				// No citable permalink or no start instant -> no item. Without
				// utc_start_date the external_id would collapse to "<id>:", so two
				// dateless occurrences of one recurring event would collide and
				// overwrite each other (review finding, PR #12) — and an event with
				// no start is useless to the brief anyway.
				if (!e?.url || e.id == null || !e.utc_start_date) continue;
				const item = tribeEventToItem(e, cfg.host, q.venue?.label);
				ctx.insertItem({
					...item,
					// The events JSON re-hashes as dates roll, so each run mints a fresh
					// document; pin items to where they were first captured.
					document_id: resolveDocumentId(
						ctx,
						doc.documentId,
						item.external_id,
						item.item_type,
					),
				});
				stored++;
			}
			page++;
		}
		ctx.note(
			`${cfg.host}${q.venue ? ` venue "${q.venue.label}" (id ${q.venue.id})` : ""}: ` +
				`stored ${stored} event(s) from ${Math.min(totalPages, maxPages)} page(s)` +
				`${reportedTotal != null ? ` of ${reportedTotal} upcoming reported by the API` : ""}` +
				`${totalPages > maxPages ? ` (capped at ${maxPages} pages)` : ""}, window start ${startDate}.`,
		);
	}
}
