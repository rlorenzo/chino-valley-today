// Task 0.1 — Chino Legistar scraper. Built on the Granicus Legistar Web API
// (webapi.legistar.com/v1/chino/...), confirmed live for Chino by direct probe.
// See reports/notes/chino-legistar.md for the full writeup: endpoint patterns,
// agenda-status semantics, the votes-endpoint quirk, and open-question evidence.
import * as cheerio from "cheerio";
import { rtfToText } from "./rtf.ts";
import type { ScraperContext, ScraperDef } from "./types.ts";

const API = "https://webapi.legistar.com/v1/chino";
const INSITE = "https://chino.legistar.com";

// ---- API shapes (subset of fields we use) ----

interface LegistarEvent {
	EventId: number;
	EventGuid: string;
	EventBodyName: string;
	EventDate: string; // "2026-07-21T00:00:00", midnight-local, no time-of-day
	EventTime: string | null;
	EventAgendaStatusName: string | null;
	EventMinutesStatusName: string | null;
	EventAgendaFile: string | null;
	EventComment: string | null;
	EventInSiteURL: string;
}

interface LegistarEventItem {
	EventItemId: number;
	EventItemGuid: string;
	EventItemEventId: number;
	EventItemAgendaSequence: number | null;
	EventItemAgendaNumber: string | null;
	EventItemAgendaNote: string | null;
	EventItemMinutesNote: string | null;
	EventItemActionName: string | null;
	EventItemActionText: string | null;
	EventItemPassedFlag: number | null;
	EventItemPassedFlagName: string | null;
	EventItemRollCallFlag: number | null;
	EventItemConsent: number | null;
	EventItemMover: string | null;
	EventItemSeconder: string | null;
	EventItemTitle: string | null;
	EventItemMatterId: number | null;
	EventItemMatterGuid: string | null;
	EventItemMatterFile: string | null;
	EventItemMatterName: string | null;
	EventItemMatterType: string | null;
	EventItemMatterStatus: string | null;
}

interface LegistarVote {
	VoteId: number;
	VotePersonId: number;
	VotePersonName: string;
	VoteValueName: string;
	VoteEventItemId: number;
}

// ---- minimal RTF -> plaintext ----
// EventItemMinutesNote (and occasionally AgendaNote) come back as RTF, not
// plain text. Chino's notes are simple single-run RTF (one font, one color,
// no embedded objects), so a small brace-depth-aware stripper is sufficient;
// this is not a general-purpose RTF parser. Verified against real samples
// during the probe (see report).
// ---- helpers ----

// IMPORTANT, hard-won finding (see reports/notes/chino-legistar.md): the Web
// API's EventItemMatterId/EventItemMatterGuid do NOT resolve on
// chino.legistar.com/LegislationDetail.aspx — that page uses a completely
// different internal ID space than the API's Matter records for the exact
// same matter (verified: File #26-406 is MatterId 3237 via the API, but ID
// 8140820 on the actual working InSite link). Building permalinks from the
// API's MatterId/MatterGuid produces a 200-with-"Invalid parameters!" page,
// not a real one. The only reliable way to get a working per-item permalink
// is to fetch the meeting's own HTML page (already have it as
// EventInSiteURL) and read the real ID/GUID pair off its rendered links,
// keyed by MatterFile (e.g. "26-406"), which the API and the HTML agree on.
async function fetchLegislationLinks(
	ctx: ScraperContext,
	event: LegistarEvent,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	try {
		const doc = await ctx.fetchDocument(event.EventInSiteURL, {
			docType: "agenda",
			title: `${event.EventBodyName.trim()} meeting detail (HTML) — ${event.EventDate.slice(0, 10)}`,
			meetingDate: event.EventDate.slice(0, 10),
		});
		const $ = cheerio.load(doc.body.toString("utf8"));
		$('a[id*="hypFile"]').each((_i, a) => {
			const $a = $(a);
			const file = $a.text().trim();
			const href = $a.attr("href");
			if (file && href)
				map.set(file, new URL(href, event.EventInSiteURL).toString());
		});
	} catch (err) {
		ctx.note(
			`Failed to fetch/parse MeetingDetail HTML for EventId ${event.EventId} (permalink lookup): ${(err as Error).message}. ` +
				`Items for this meeting will fall back to the meeting-level EventInSiteURL instead of per-item permalinks.`,
		);
	}
	return map;
}

function itemSourceUrl(
	item: LegistarEventItem,
	legislationLinks: Map<string, string>,
	fallback: string,
): string {
	if (item.EventItemMatterFile) {
		const real = legislationLinks.get(item.EventItemMatterFile);
		if (real) return real;
	}
	return fallback; // event's EventInSiteURL; API always populates this
}

function itemBody(item: LegistarEventItem): string | null {
	const parts = [
		rtfToText(item.EventItemAgendaNote),
		rtfToText(item.EventItemMinutesNote),
	].filter((t): t is string => !!t);
	return parts.length ? parts.join("\n\n") : null;
}

async function fetchEventItems(
	ctx: ScraperContext,
	event: LegistarEvent,
): Promise<{ documentId: number; items: LegistarEventItem[] }> {
	const doc = await ctx.fetchDocument(
		`${API}/events/${event.EventId}/eventitems?AgendaNote=1&MinutesNote=1`,
		{
			docType: "agenda",
			title: `${event.EventBodyName.trim()} agenda items — ${event.EventDate.slice(0, 10)} (EventId ${event.EventId})`,
			meetingDate: event.EventDate.slice(0, 10),
		},
	);
	const items = JSON.parse(doc.body.toString("utf8")) as LegistarEventItem[];
	return { documentId: doc.documentId, items };
}

async function ingestMeeting(
	ctx: ScraperContext,
	event: LegistarEvent,
	documentId: number,
	items: LegistarEventItem[],
	legislationLinks: Map<string, string>,
): Promise<void> {
	const occurredAt = new Date(event.EventDate).toISOString();
	for (const item of items) {
		ctx.insertItem({
			document_id: documentId,
			source_url: itemSourceUrl(item, legislationLinks, event.EventInSiteURL),
			item_type: "agenda_item",
			external_id: String(item.EventItemId),
			title: item.EventItemTitle,
			body: itemBody(item),
			occurred_at: occurredAt,
			meta: {
				eventId: event.EventId,
				eventBodyName: event.EventBodyName.trim(),
				agendaNumber: item.EventItemAgendaNumber,
				agendaSequence: item.EventItemAgendaSequence,
				matterId: item.EventItemMatterId,
				matterGuid: item.EventItemMatterGuid,
				matterFile: item.EventItemMatterFile,
				matterName: item.EventItemMatterName,
				matterType: item.EventItemMatterType,
				matterStatus: item.EventItemMatterStatus,
				actionName: item.EventItemActionName,
				actionText: item.EventItemActionText,
				passedFlag: item.EventItemPassedFlag,
				passedFlagName: item.EventItemPassedFlagName,
				rollCallFlag: item.EventItemRollCallFlag,
				consent: item.EventItemConsent,
				mover: item.EventItemMover,
				seconder: item.EventItemSeconder,
			},
		});
	}

	if (event.EventAgendaFile) {
		// Agenda PDFs live on chino.legistar1.com, a separate host from the API
		// and the InSite portal. Its robots.txt is a blanket "Disallow: /" — see
		// ctx.note() at call site for why skipRobots is justified here.
		try {
			await ctx.fetchDocument(event.EventAgendaFile, {
				docType: "agenda",
				title: `${event.EventBodyName.trim()} agenda PDF — ${event.EventDate.slice(0, 10)}`,
				meetingDate: event.EventDate.slice(0, 10),
				skipRobots: true,
			});
		} catch (err) {
			ctx.note(
				`Failed to fetch agenda PDF for EventId ${event.EventId}: ${(err as Error).message}`,
			);
		}
	}
}

// Sample votes for a meeting. Legistar's /eventitems/{id}/votes endpoint has
// a real data-integrity quirk (verified by hand during the probe): for an
// EventItemId that was decided as part of an omnibus/consent-calendar motion
// (no distinct roll-call vote of its own), the endpoint does NOT return 404
// or an empty array — it returns the votes belonging to a DIFFERENT
// EventItemId (the motion's actual roll-call "host" item), unchanged. The
// only way to detect this is to check that every returned vote's
// VoteEventItemId equals the id you requested; we do that here and discard
// mismatches rather than store misattributed votes.
async function sampleVotes(
	ctx: ScraperContext,
	event: LegistarEvent,
	documentId: number,
	items: LegistarEventItem[],
	legislationLinks: Map<string, string>,
): Promise<void> {
	const voted = items.filter((i) => i.EventItemPassedFlag !== null);
	if (voted.length === 0) {
		ctx.note(
			`No event items with a non-null PassedFlag in ${event.EventBodyName.trim()} EventId ${event.EventId} — nothing to sample for votes.`,
		);
		return;
	}

	// Group by (mover, seconder): the largest group is almost always the
	// omnibus consent-calendar motion (many items, one shared mover/seconder);
	// smaller/unique groups are individually-moved items with their own real
	// roll-call vote. Sample from both so we exercise (and can report) both
	// behaviors, capped at 8 requests to stay polite.
	const groups = new Map<string, LegistarEventItem[]>();
	for (const it of voted) {
		const key = `${it.EventItemMover ?? ""}|${it.EventItemSeconder ?? ""}`;
		const arr = groups.get(key) ?? [];
		arr.push(it);
		groups.set(key, arr);
	}
	const sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length);
	const sample: LegistarEventItem[] = [];
	for (const g of sortedGroups) {
		if (sample.length >= 8) break;
		const take = g.length > 3 ? Math.min(2, g.length) : g.length;
		sample.push(...g.slice(0, take));
	}
	if (sample.length > 8) sample.length = 8;

	let consistent = 0;
	let mismatched = 0;
	let votesStored = 0;
	for (const item of sample) {
		let votes: LegistarVote[];
		try {
			const res = await ctx.fetchRaw(
				`${API}/eventitems/${item.EventItemId}/votes`,
			);
			if (!res.ok) {
				ctx.note(
					`Votes probe for EventItemId ${item.EventItemId} returned HTTP ${res.status}.`,
				);
				continue;
			}
			votes = JSON.parse(res.body.toString("utf8")) as LegistarVote[];
		} catch (err) {
			ctx.note(
				`Votes probe failed for EventItemId ${item.EventItemId}: ${(err as Error).message}`,
			);
			continue;
		}
		if (votes.length === 0) continue;
		const selfConsistent = votes.every(
			(v) => v.VoteEventItemId === item.EventItemId,
		);
		if (!selfConsistent) {
			mismatched++;
			continue;
		}
		consistent++;
		const sourceUrl = itemSourceUrl(
			item,
			legislationLinks,
			event.EventInSiteURL,
		);
		const occurredAt = new Date(event.EventDate).toISOString();
		for (const v of votes) {
			ctx.insertItem({
				document_id: documentId,
				source_url: sourceUrl,
				item_type: "vote",
				external_id: String(v.VoteId),
				title: `${v.VotePersonName}: ${v.VoteValueName}`,
				occurred_at: occurredAt,
				meta: {
					eventItemId: item.EventItemId,
					eventItemTitle: item.EventItemTitle,
					person: v.VotePersonName,
					personId: v.VotePersonId,
					vote: v.VoteValueName,
				},
			});
			votesStored++;
		}
	}
	ctx.note(
		`Vote sampling on ${event.EventBodyName.trim()} EventId ${event.EventId}: probed ${sample.length}/${voted.length} items with a non-null PassedFlag. ` +
			`${consistent} item(s) returned self-consistent per-item votes (${votesStored} vote records stored); ${mismatched} item(s) returned another item's votes ` +
			`instead of their own (the omnibus-motion quirk described above — discarded, not stored).`,
	);
}

const scraper: ScraperDef = {
	key: "chino-legistar",
	name: "Chino Legistar (Granicus Web API)",
	baseUrl: API,
	method: "api",
	async run(ctx) {
		ctx.note(
			"webapi.legistar.com and chino.legistar.com both return HTTP 404 for /robots.txt (no robots file present); " +
				"the fetcher fails open in that case, so no skipRobots flag is used for either host. " +
				'chino.legistar1.com (the agenda-PDF file host) DOES have a robots.txt with a blanket "User-agent: * / Disallow: /", ' +
				"which reads as generic search-crawler avoidance on a file server, not a restriction on fetching a specific document " +
				"whose URL we already have from the official Legistar Web API response (EventAgendaFile). skipRobots: true is used " +
				"only for those PDF fetches.",
		);
		ctx.note(
			"Data-integrity finding: the Web API's EventItemMatterId/EventItemMatterGuid do NOT resolve on " +
				"chino.legistar.com/LegislationDetail.aspx — that page uses a different internal ID space than the API's Matter " +
				"records for the same matter (verified by hand: File #26-406 is MatterId 3237 via the API, but the real working " +
				'link uses ID=8140820). Building permalinks from MatterId/MatterGuid produces an HTTP 200 "Invalid parameters!" ' +
				"page, not a real one. This scraper instead fetches each meeting's own MeetingDetail.aspx HTML and reads the " +
				"real ID/GUID pairs off the rendered links, keyed by MatterFile (which the API and HTML do agree on).",
		);
		ctx.note(
			"HTTP behavior finding: the MeetingDetail.aspx HTML (ASP.NET WebForms + Telerik controls) is NOT byte-stable across " +
				"identical requests — every render embeds fresh __VIEWSTATE/__EVENTVALIDATION values and WebResource.axd cache-" +
				"busting timestamps, so its content_hash changes on every fetch even when the actual agenda data is unchanged. " +
				"Verified by diffing two consecutive fetches of the same URL: only framework plumbing differed, not agenda " +
				"content. Practical effect: documents.documentsNew will NOT reach 0 for this doc on repeat runs (a new row is " +
				"created each time), unlike the plain-JSON API endpoints, which dedupe cleanly by content hash. Items derived " +
				"from it (via the eventitems JSON, not this HTML) are unaffected and still dedupe correctly by external_id.",
		);

		// 1. Recent events window (top 30, newest first).
		const eventsDoc = await ctx.fetchDocument(
			`${API}/events?%24top=30&%24orderby=EventDate%20desc`,
			{
				docType: "listing",
				title: "Chino Legistar recent events (top 30, EventDate desc)",
			},
		);
		const events = JSON.parse(
			eventsDoc.body.toString("utf8"),
		) as LegistarEvent[];
		const bodies = [...new Set(events.map((e) => e.EventBodyName.trim()))];
		ctx.note(
			`Fetched ${events.length} recent events. EventBodyName values seen: ${bodies.join(", ")}.`,
		);

		if (bodies.includes("Planning Commission")) {
			ctx.note(
				'Planning Commission DOES hold meetings in Legistar (EventBodyName="Planning Commission" present with real, ' +
					"non-cancelled events and populated event items) — answers PLAN.md open question 2 for the Legistar side: " +
					"Planning Commission agendas are NOT exclusive to the CivicPlus Agenda Center.",
			);
		}

		const agendaStatuses = [
			...new Set(events.map((e) => e.EventAgendaStatusName)),
		];
		ctx.note(
			`EventAgendaStatusName values observed: ${agendaStatuses.join(", ")}. Treating "Final" and "Final Revised" as ` +
				`published agendas; "Hidden" as not-yet-published. IMPORTANT caveat found during this run: agenda status alone ` +
				`is not sufficient — a meeting can show EventAgendaStatusName="Final" and still have zero EventItems if ` +
				`EventComment says the meeting was cancelled (see below).`,
		);

		const now = Date.now();
		const isPast = (e: LegistarEvent) => new Date(e.EventDate).getTime() <= now;
		const isPublishedAgenda = (e: LegistarEvent) =>
			e.EventAgendaStatusName === "Final" ||
			e.EventAgendaStatusName === "Final Revised";
		const isCancelled = (e: LegistarEvent) =>
			(e.EventComment ?? "").includes("Cancelled");

		// 2. Find the most recent PAST City Council meeting with a published
		// agenda AND actual event items (cancelled meetings can pass the first
		// two checks and still have none).
		const councilCandidates = events.filter(
			(e) =>
				e.EventBodyName.trim() === "City Council" &&
				isPast(e) &&
				isPublishedAgenda(e),
		);

		let targetMeeting: LegistarEvent | null = null;
		let targetDocId = -1;
		let targetItems: LegistarEventItem[] = [];
		for (const cand of councilCandidates) {
			if (isCancelled(cand)) {
				ctx.note(
					`Skipping City Council EventId ${cand.EventId} (${cand.EventDate.slice(0, 10)}): EventComment = ` +
						`"${cand.EventComment}" despite EventAgendaStatusName="${cand.EventAgendaStatusName}" — cancelled meetings ` +
						`can carry a "Final" agenda status with zero items.`,
				);
				continue;
			}
			const { documentId, items } = await fetchEventItems(ctx, cand);
			if (items.length === 0) {
				ctx.note(
					`City Council EventId ${cand.EventId} (${cand.EventDate.slice(0, 10)}): agenda status ` +
						`"${cand.EventAgendaStatusName}" but 0 event items — skipping, trying the next most recent meeting.`,
				);
				continue;
			}
			targetMeeting = cand;
			targetDocId = documentId;
			targetItems = items;
			break;
		}

		if (!targetMeeting) {
			// The window holds the 30 most recent events across every body, so it
			// reaches back weeks. Council meets twice a month and its agendas are
			// published: finding none that qualifies means the window is too narrow
			// or the API's shape has moved, and either way this run ingested
			// nothing. Noting it and returning would record `success` with 0 items,
			// which is how chinohills-swagit hid a six-day outage.
			throw new Error(
				`No past City Council meeting with both a published agenda status AND populated event items was found ` +
					`among the ${councilCandidates.length} candidate(s) in the top-30 events window — widen the window, or ` +
					"check whether the events API has changed.",
			);
		}

		ctx.note(
			`Target meeting: City Council EventId=${targetMeeting.EventId}, date=${targetMeeting.EventDate.slice(0, 10)}, ` +
				`agendaStatus=${targetMeeting.EventAgendaStatusName}, minutesStatus=${targetMeeting.EventMinutesStatusName}, ` +
				`${targetItems.length} event items (minutes status "Draft" here is expected/normal — Chino minutes are ` +
				`typically approved, and flip to "Final", at the NEXT council meeting).`,
		);

		const targetLinks = await fetchLegislationLinks(ctx, targetMeeting);
		await ingestMeeting(
			ctx,
			targetMeeting,
			targetDocId,
			targetItems,
			targetLinks,
		);
		await sampleVotes(
			ctx,
			targetMeeting,
			targetDocId,
			targetItems,
			targetLinks,
		);

		const withMatter = targetItems.filter((i) => i.EventItemMatterFile);
		const withRealLink = withMatter.filter((i) =>
			targetLinks.has(i.EventItemMatterFile as string),
		);
		const nullTitle = targetItems.filter((i) => !i.EventItemTitle);
		ctx.note(
			`Target meeting item quality: ${withMatter.length}/${targetItems.length} items carry a MatterFile; ` +
				`${withRealLink.length}/${withMatter.length} of those resolved to a real LegislationDetail.aspx permalink via the ` +
				`HTML lookup (the rest fall back to the meeting's EventInSiteURL — still a working, real link, just meeting- ` +
				`rather than item-level). ${nullTitle.length} item(s) have a null EventItemTitle (typically the roll-call ` +
				`"motion summary" item for an omnibus vote, e.g. "approved the Consent Agenda" — title is null but ` +
				`EventItemActionText carries the real content).`,
		);

		// 3. One or two other recent meetings, prioritizing Planning Commission
		// (open question 2) then whatever other body appears next.
		const otherCandidatesByBody = new Map<string, LegistarEvent>();
		for (const e of events) {
			const body = e.EventBodyName.trim();
			if (body === "City Council") continue;
			if (!isPast(e) || !isPublishedAgenda(e) || isCancelled(e)) continue;
			if (!otherCandidatesByBody.has(body)) otherCandidatesByBody.set(body, e);
		}
		const priorityOrder = [
			"Planning Commission",
			...[...otherCandidatesByBody.keys()].filter(
				(b) => b !== "Planning Commission",
			),
		];

		let probed = 0;
		for (const body of priorityOrder) {
			if (probed >= 2) break;
			const cand = otherCandidatesByBody.get(body);
			if (!cand) continue;
			const { documentId, items } = await fetchEventItems(ctx, cand);
			if (items.length === 0) {
				ctx.note(
					`${body} EventId ${cand.EventId} (${cand.EventDate.slice(0, 10)}): 0 event items — skipping.`,
				);
				continue;
			}
			ctx.note(
				`Probe meeting: ${body} EventId=${cand.EventId}, date=${cand.EventDate.slice(0, 10)}, ${items.length} event items.`,
			);
			const probeLinks = await fetchLegislationLinks(ctx, cand);
			await ingestMeeting(ctx, cand, documentId, items, probeLinks);
			probed++;
		}
		if (probed === 0) {
			ctx.note(
				"No non-City-Council body had a past, published, non-cancelled meeting with items in the top-30 window to probe.",
			);
		}

		// 4. One-call probe of the /matters endpoint's test-data quirk (already
		// observed by hand during the API probe): note it, don't ingest from it.
		try {
			const mattersProbe = await ctx.fetchRaw(`${API}/matters?%24top=5`);
			if (mattersProbe.ok) {
				const matters = JSON.parse(
					mattersProbe.body.toString("utf8"),
				) as Array<{
					MatterName?: string;
					MatterTitle?: string;
					MatterFile?: string;
				}>;
				const testLooking = matters.filter(
					(m) =>
						/\btest\b/i.test(m.MatterTitle ?? "") ||
						/\bsample\b/i.test(m.MatterName ?? ""),
				);
				ctx.note(
					`/matters probe (not ingested — this scraper only walks events/eventitems): Chino's Legistar instance contains ` +
						`at least one obvious test/sample matter (e.g. MatterFile "${testLooking[0]?.MatterFile ?? "n/a"}", ` +
						`MatterName "${testLooking[0]?.MatterName ?? ""}", MatterTitle "${testLooking[0]?.MatterTitle ?? ""}"). ` +
						`Because we derive items from real events/eventitems for actual meetings rather than scanning /matters directly, ` +
						`this test data does not appear in our items UNLESS a real agenda item happens to reference a test matter as its ` +
						`EventItemMatterId — we did not observe that in the meetings ingested this run, but a production version should ` +
						`filter matters whose MatterTitle/MatterName look like placeholder text before trusting them in synthesis.`,
				);
			}
		} catch (err) {
			ctx.note(`/matters probe failed: ${(err as Error).message}`);
		}

		// 5. RSS fallback probe — existence check only, not ingested (the Web
		// API is the primary, richer path; this is just documented as a backup).
		try {
			const feedProbe = await ctx.fetchRaw(`${INSITE}/Feed.ashx?M=Calendar`);
			ctx.note(
				`RSS fallback probe: ${INSITE}/Feed.ashx?M=Calendar -> HTTP ${feedProbe.status}` +
					(feedProbe.ok
						? " (feed exists; not ingested — Web API is the primary, richer path for this source)."
						: "."),
			);
		} catch (err) {
			ctx.note(`RSS fallback probe failed: ${(err as Error).message}`);
		}
	},
};

export default scraper;
