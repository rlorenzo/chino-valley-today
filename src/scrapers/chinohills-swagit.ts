// Task 0.5 — Chino Hills Swagit council meeting transcripts. See
// reports/notes/chinohills-swagit.md for the full endpoint-discovery log,
// the ?ts= deep-link verification evidence, and caption-quality examples.
import * as cheerio from "cheerio";
import type { ScraperContext, ScraperDef } from "./types.ts";

const HOST = "https://chinohillsca.new.swagit.com";
// The public entry point (chinohillsca.new.swagit.com/city-council-meeting/)
// is a client-rendered SPA shell whose <tbody> is empty in the raw HTML (no
// XHR either — confirmed with a real browser, not just curl). The working
// listing lives behind the LEGACY domain's redirect chain:
//   https://chinohillsca.swagit.com/  --301-->  {HOST}/views/default/  --302-->  {HOST}/views/158
// {HOST}/views/158 is server-rendered HTML with real <tr> rows. This is the
// "/views/..." pattern PLAN.md told us to watch for. We hit /views/default/
// directly (same host as everything else we fetch); fetch()'s redirect:
// 'follow' chases the one remaining hop to /views/158 transparently.
const LISTING_URL = `${HOST}/views/default/`;

// Volume bound (PLAN.md Task 0.5 / brief): if a transcript has more than
// ~1500 natural segments, store only the first ~1000 and note the truncation.
const TRUNCATE_ABOVE = 1500;
const MAX_SEGMENTS = 1000;

// How many candidate meetings (newest first) to try before giving up if the
// most recent one turns out to have no machine transcript.
const MAX_CANDIDATES_TRIED = 5;

// Probe offset for the ?ts= deep-link verification (brief suggests 120s).
const TS_PROBE_SECONDS = 120;

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

// Parses "Jul 14, 2026" (listing rows) or a leading "Jul 14, 2026 City..."
// (video page <title>/og:title) without relying on engine-specific loose
// Date parsing. Returns null if the text doesn't match.
function parseDateText(text: string): { iso: string; time: number } | null {
	const m = text.trim().match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})/);
	if (!m) return null;
	const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
	if (mon === undefined) return null;
	const day = parseInt(m[2], 10);
	const year = parseInt(m[3], 10);
	const iso = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	return { iso, time: Date.UTC(year, mon, day) };
}

interface VideoRow {
	id: string;
	title: string;
	dateText: string;
	url: string;
}

// The listing table's <tbody> holds one <tr> per video, with a
// href="/videos/<id>" link in the first cell and the date as plain text in
// the second cell. A later cell repeats /videos/<id> and /videos/<id>/agenda
// links; anchoring the id regex to end-of-string excludes those.
function parseListing(html: string): VideoRow[] {
	const $ = cheerio.load(html);
	const rows: VideoRow[] = [];
	$("tr").each((_i, tr) => {
		const $tr = $(tr);
		const cells = $tr.find("td");
		if (cells.length < 2) return; // header row or malformed
		let id: string | null = null;
		let title = "";
		cells
			.eq(0)
			.find('a[href^="/videos/"]')
			.each((_j, a) => {
				const href = $(a).attr("href");
				const m = href?.match(/^\/videos\/(\d+)$/);
				if (m && !id) {
					id = m[1];
					title = $(a).text().trim();
				}
			});
		if (!id) return;
		const dateText = cells.eq(1).text().trim();
		rows.push({ id, title, dateText, url: `${HOST}/videos/${id}` });
	});
	return rows;
}

function sortByDateDesc(rows: VideoRow[]): VideoRow[] {
	return rows
		.map((r) => ({ r, d: parseDateText(r.dateText) }))
		.filter(
			(x): x is { r: VideoRow; d: { iso: string; time: number } } =>
				x.d !== null,
		)
		.sort((a, b) => b.d.time - a.d.time)
		.map((x) => x.r);
}

interface TranscriptSegment {
	text: string;
	start: number;
	end: number;
}

// The video page embeds the full voice-to-text transcript directly in the
// HTML: #transcript-fragments contains one <p> per caption line, each made
// of word-level <a data-ts="SECONDS">WORD</a> anchors (data-ts is a float,
// seconds from meeting start; the anchor's onclick calls the player's
// seek()). A handful of <p> tags carry no anchors at all — those are
// chapter-style markers (e.g. "[ CONSENT CALENDAR (10 ITEMS) ...]") or
// periodic timestamp headers (e.g. "[00:05:01]") injected every ~5 minutes;
// we treat <p> as the natural segment granularity and skip anchor-less ones
// since they're not spoken transcript content.
function extractSegments($: cheerio.CheerioAPI): TranscriptSegment[] {
	const frag = $("#transcript-fragments");
	const segments: TranscriptSegment[] = [];
	frag.find("p").each((_i, el) => {
		const $p = $(el);
		const anchors = $p.find("a[data-ts]");
		if (anchors.length === 0) return;
		const words: string[] = [];
		let start = Infinity;
		let end = -Infinity;
		anchors.each((_j, a) => {
			const ts = parseFloat($(a).attr("data-ts") ?? "NaN");
			if (!Number.isNaN(ts)) {
				if (ts < start) start = ts;
				if (ts > end) end = ts;
			}
			const w = $(a).text().trim();
			if (w) words.push(w);
		});
		const text = words.join(" ").replace(/\s+/g, " ").trim();
		if (!text || !Number.isFinite(start)) return;
		segments.push({ text, start, end: Number.isFinite(end) ? end : start });
	});
	return segments;
}

// Verifies PLAN.md open question 3 ("Swagit players commonly accept
// ?ts=SECONDS") the only way possible without a real browser executing JS:
// diff the server-RENDERED HTML for the same video URL with and without
// ?ts=. If the server bakes a hardcoded player.currentTime(N)/
// jwplayer(...).seek(N) call into the page in place of the generic
// location.hash-based seek-on-play logic, that is direct evidence the
// query param is parsed server-side and wired into player init — not an
// inference from reading client JS, and not merely "unverifiable
// server-side" (we DID get server-side confirmation). We do not confirm
// actual playback offset visually (that would need a real browser
// interacting with the video element), so the verdict below is scoped to
// what was actually checked.
async function verifyTsDeepLink(
	ctx: ScraperContext,
	videoUrl: string,
): Promise<boolean> {
	try {
		const res = await ctx.fetchRaw(`${videoUrl}?ts=${TS_PROBE_SECONDS}`);
		if (!res.ok) {
			ctx.note(
				`Timestamp deep-link probe: GET ${videoUrl}?ts=${TS_PROBE_SECONDS} returned HTTP ${res.status} — ` +
					"could not verify; falling back to plain video URLs without a timestamp.",
			);
			return false;
		}
		const body = res.body.toString("utf8");
		const hasHardcodedSeek =
			body.includes(`.currentTime(${TS_PROBE_SECONDS})`) ||
			body.includes(`.seek(${TS_PROBE_SECONDS})`);
		const stillGeneric = body.includes("location.hash");
		if (hasHardcodedSeek && !stillGeneric) {
			ctx.note(
				`Timestamp deep-link (PLAN open question 3) VERIFIED SERVER-SIDE: requesting ${videoUrl}?ts=${TS_PROBE_SECONDS} ` +
					`causes the server to replace the page's generic location.hash-based player-seek initializer with a hardcoded ` +
					`player.currentTime(${TS_PROBE_SECONDS})/jwplayer("player").seek(${TS_PROBE_SECONDS}) call embedded directly in ` +
					`the returned HTML (confirmed by diffing this response against the same URL fetched without ?ts=; both the ` +
					`video.js-path and jwplayer-fallback-path init blocks changed). This is genuine server-side confirmation that ` +
					`?ts=SECONDS is parsed and wired into player init, not an inference from reading client JS and not merely ` +
					'"appears in player config" — the server computed a different response body for the two requests. What was ' +
					"NOT verified: actual visual playback offset in a running browser (would require executing the page's JS " +
					"against a real <video>/jwplayer instance and observing currentTime after play) — that step was not run. " +
					`Verdict: source_url for transcript_segment items below uses ${videoUrl}?ts=<startSeconds>.`,
			);
			return true;
		}
		ctx.note(
			`Timestamp deep-link probe: ?ts=${TS_PROBE_SECONDS} did NOT produce the expected hardcoded seek call ` +
				`(hasHardcodedSeek=${hasHardcodedSeek}, stillGeneric=${stillGeneric}) — falling back to plain video URLs ` +
				"without a timestamp.",
		);
		return false;
	} catch (err) {
		ctx.note(
			`Timestamp deep-link probe failed: ${(err as Error).message} — falling back to plain video URLs without a timestamp.`,
		);
		return false;
	}
}

const scraper: ScraperDef = {
	key: "chinohills-swagit",
	name: "Chino Hills Swagit (City Council meeting transcripts)",
	baseUrl: HOST,
	method: "captions",
	async run(ctx) {
		ctx.note(
			`robots.txt at ${HOST}/robots.txt is present but every User-agent/Disallow line is commented out ` +
				'(the stock Swagit template with "# To ban all spiders ... uncomment the next two lines"); the site is fully ' +
				"open to crawlers. No skipRobots flag is used anywhere in this scraper — nothing is blocked.",
		);

		// --- 1. Find the listing. ---
		// The public entry (HOST + "/" -> "/city-council-meeting/") is a
		// client-rendered SPA shell: fetching it returns a <table id="video-table">
		// with an EMPTY <tbody> and no XHR/fetch requests at all (verified with a
		// real Chrome instance via devtools network panel, not just curl) — this
		// Swagit deployment's public listing view never populates. The working
		// path was found by trying the legacy (pre-"new.") domain, which redirects
		// through a "/views/..." path — the exact pattern PLAN.md said to watch for.
		const listing = await ctx.fetchRaw(LISTING_URL);
		if (!listing.ok) {
			ctx.note(
				`Listing probe FAILED: GET ${LISTING_URL} returned HTTP ${listing.status}. The public SPA entry point at ` +
					`${HOST}/city-council-meeting/ returns 200 but its video table is empty in raw HTML with no XHR calls ` +
					"(confirmed via browser devtools network panel) — no usable listing endpoint found. Stopping.",
			);
			return;
		}
		const allRows = parseListing(listing.body.toString("utf8"));
		ctx.note(
			`Endpoint discovery: ${LISTING_URL} (redirects to ${listing.finalUrl}) is server-rendered HTML with real <tr> ` +
				`rows — ${allRows.length} video rows parsed. This is the listing source used, in place of the empty public ` +
				`SPA shell at ${HOST}/city-council-meeting/.`,
		);
		const rows = sortByDateDesc(allRows);
		if (rows.length === 0) {
			ctx.note(
				"No parsable/dated video rows found in the listing — nothing to ingest.",
			);
			return;
		}

		// --- 2. Walk newest-first until one has a real transcript. ---
		let target: VideoRow | null = null;
		let videoDoc: Awaited<ReturnType<ScraperContext["fetchDocument"]>> | null =
			null;
		let $video: cheerio.CheerioAPI | null = null;
		let segments: TranscriptSegment[] = [];
		let tried = 0;

		for (const row of rows) {
			if (tried >= MAX_CANDIDATES_TRIED) break;
			tried++;
			const dateInfo = parseDateText(row.dateText);
			const doc = await ctx.fetchDocument(row.url, {
				docType: "video",
				title: row.title || undefined,
				meetingDate: dateInfo?.iso,
			});
			const $ = cheerio.load(doc.body.toString("utf8"));
			const segs = extractSegments($);
			if (segs.length === 0) {
				ctx.note(
					`Video ${row.id} ("${row.title}", ${row.dateText}): fetched the video page but found no ` +
						"#transcript-fragments segments (either no #transcript-fragments element at all, or it has no <p> tags " +
						"with data-ts anchors) — this meeting has no machine transcript available yet. Trying the next most " +
						"recent meeting.",
				);
				continue;
			}
			target = row;
			videoDoc = doc;
			$video = $;
			segments = segs;
			break;
		}

		if (!target || !videoDoc || !$video) {
			ctx.note(
				`Tried ${tried} most-recent meeting(s) in the listing and none had a machine transcript — nothing to ingest. ` +
					`Meetings checked: ${rows
						.slice(0, tried)
						.map((r) => `${r.id} (${r.dateText})`)
						.join(", ")}.`,
			);
			return;
		}

		// Prefer the date embedded in the video page's own <title> (server
		// metadata tied to the archived document) over the listing row's date
		// column; both were consistent for every meeting checked during
		// development, but the page's own title is the more authoritative source.
		const pageTitle = $video("title").first().text();
		const meetingDate =
			parseDateText(pageTitle) ?? parseDateText(target.dateText);

		ctx.note(
			`Target meeting: video ${target.id}, "${target.title || pageTitle}", date=${meetingDate?.iso ?? "unknown"} ` +
				`(${tried} candidate(s) tried before finding one with a transcript). ${segments.length} transcript ` +
				"paragraphs (<p> elements with word-level data-ts anchors) parsed from the embedded HTML.",
		);

		// --- 3. Endpoint discovery: also probe (and document) the other shapes
		// PLAN.md/the brief told us to check for, before settling on the HTML
		// page as the parse source. ---
		const vid = target.id;
		const probes: Array<[string, string]> = [
			[`${HOST}/videos/${vid}/transcript`, "plain-text transcript download"],
			[`${HOST}/videos/${vid}/captions`, 'guessed "captions" alias'],
			[`${HOST}/videos/${vid}.vtt`, "guessed bare .vtt"],
			[`${HOST}/videos/${vid}/captions.vtt`, "guessed captions.vtt"],
			[`${HOST}/videos/${vid}.json`, "guessed bare .json"],
			[`${HOST}/videos/${vid}/transcript.json`, "guessed transcript.json"],
			[`${HOST}/videos/${vid}/transcript.vtt`, "guessed transcript.vtt"],
			[
				`${HOST}/captions/${vid}`,
				"guessed /captions/<id> (PLAN.md pattern guess)",
			],
		];
		const probeResults: string[] = [];
		let transcriptTxtUrl: string | null = null;
		let transcriptTxtOk = false;
		for (const [url, label] of probes) {
			try {
				const res = await ctx.fetchRaw(url);
				probeResults.push(
					`${url} (${label}) -> HTTP ${res.status}, content-type=${res.contentType ?? "n/a"}`,
				);
				if (url.endsWith("/transcript")) {
					transcriptTxtUrl = url;
					transcriptTxtOk = res.ok;
				}
			} catch (err) {
				probeResults.push(
					`${url} (${label}) -> ERROR: ${(err as Error).message}`,
				);
			}
		}
		ctx.note(
			"Endpoint discovery log (full results, negative and positive, in reports/notes/chinohills-swagit.md): " +
				probeResults.join(" | "),
		);
		ctx.note(
			`Format finding: /videos/<id>/transcript.json and /videos/<id>/transcript.vtt both return HTTP 200 but with ` +
				`identical bytes to the plain /videos/<id>/transcript endpoint (same ETag, same Content-Disposition ` +
				`filename ending in .txt) — Rails is ignoring the unrecognized format suffix and serving the default text ` +
				"action, NOT real JSON or VTT. /videos/<id>.vtt, /videos/<id>.json, and /videos/<id>/captions.vtt all 500. " +
				"/videos/<id>/captions returns 200 but is byte-for-byte the same full video page HTML, not a separate " +
				"captions resource. No VTT or JSON transcript endpoint exists on this Swagit deployment; the richest " +
				"available source is the word-level data-ts anchors embedded in the video page HTML itself, which is what " +
				"this scraper parses.",
		);

		// Archive the plain-text transcript download too (docType 'captions').
		// It is NOT the parse source (it lacks per-word timestamps, only
		// ~5-minute periodic markers) — segments/timestamps still come from the
		// HTML page. But its content is byte-stable across requests (confirmed:
		// identical content_hash across three separate fetches spaced minutes
		// apart), unlike the video HTML page, which embeds a fresh CSRF token on
		// every response and therefore gets a NEW documents row every run. Items
		// dedupe on (document_id, external_id, item_type) — if items.document_id
		// pointed at the churning video-page document, every run would create a
		// new document_id and every item would look "new" again despite having
		// the same external_id. So items below attach to THIS stable document,
		// not videoDoc. This mirrors chino-legistar's pattern of keeping an
		// unstable HTML fetch for extraction only, off the items' dedup path.
		let itemsDocumentId = videoDoc.documentId;
		if (transcriptTxtUrl && transcriptTxtOk) {
			try {
				const txtDoc = await ctx.fetchDocument(transcriptTxtUrl, {
					docType: "captions",
					title: `${target.title || pageTitle} — plain-text transcript`,
					meetingDate: meetingDate?.iso,
				});
				itemsDocumentId = txtDoc.documentId;
				ctx.note(
					`Archived the plain-text transcript download (${transcriptTxtUrl}) as docType 'captions'. Not used as the ` +
						"parse source (see format finding above), but its content_hash IS stable across requests, so this " +
						"document — not the video HTML page — is what transcript_segment items below attach to via document_id, " +
						"for correct idempotency across runs (see HTTP/caching note below).",
				);
			} catch (err) {
				ctx.note(
					`Failed to archive plain-text transcript ${transcriptTxtUrl}: ${(err as Error).message}. Items will attach ` +
						"to the video HTML page's document instead, which will NOT dedupe cleanly across runs (its content_hash " +
						"changes every fetch — see HTTP/caching note below).",
				);
			}
		} else {
			ctx.note(
				"Plain-text transcript endpoint unavailable this run — items will attach to the video HTML page's document " +
					"instead, which will NOT dedupe cleanly across runs (see HTTP/caching note below).",
			);
		}

		// --- 4. Verify (not assume) the ?ts= deep-link mechanism. ---
		const tsSupported = await verifyTsDeepLink(ctx, target.url);

		// --- 5. Caption-quality observations for the Phase 1 name-whitelist. ---
		ctx.note(
			"Caption quality on proper names (voice-to-text, unedited — feeds Phase 1 proper-name whitelist design): " +
				'(1) the city\'s own name is inconsistently transcribed — "CHINO HILLS" appears correctly dozens of times ' +
				'but "CHINO HILL" (dropped terminal S) also appears multiple times in the same transcript. ' +
				'(2) the presiding Mayor\'s surname (clearly "MARQUEZ" — appears correctly 8 times, e.g. "VICE MAYOR ' +
				'MARQUEZ"/roll-call context) is ALSO rendered as "MARQUE", "MARK", "JOSS", "JOES", and "JOE\'S" at other ' +
				"points in the same meeting — six distinct spellings of one person's name. (3) a development project name " +
				"spoken repeatedly by the same staff presenter within about a minute of each other is transcribed as " +
				'"VILLA BORBA", then "VILLA BOVA", then "VILLA BBA" in three consecutive mentions — same speaker, same ' +
				'topic, three different spellings. A public commenter\'s name is also rendered as "JEFFREY VILLA DLI", which ' +
				"reads like a garbled surname. None of these are edge cases requiring a search — they surfaced from reading " +
				"a single ordinary meeting transcript, which is the strongest argument for why Gate 1c (proper-name " +
				"whitelist against inputs) cannot be skipped for anything sourced from these transcripts.",
		);
		ctx.note(
			"Timestamp availability: every transcript paragraph has a real word-level start time (data-ts, float seconds " +
				'from meeting start) taken from the first word anchor in that <p>; "endSeconds" is the last word anchor\'s ' +
				"timestamp in the same paragraph (an approximation of when that word STARTED, not necessarily when the " +
				"segment finished being spoken — no per-word duration is available from this source).",
		);
		ctx.note(
			`HTTP/caching behavior: the video page's ETag is NOT stable across identical requests (two consecutive GETs ` +
				`of the same URL returned different weak ETags) — this page embeds a per-request CSRF token and session ` +
				"cookie, so content_hash (and therefore documents.id) differs on every fetch even though the transcript " +
				"content is unchanged. Same pattern as chino-legistar's MeetingDetail.aspx finding: documentsNew will NOT " +
				"reach 0 for the video-page doc on repeat runs. UNLIKE chino-legistar's case, this scraper's items are " +
				"actually derived FROM that unstable page (the timestamps live only in its HTML) — if items.document_id " +
				"pointed at it directly, the (document_id, external_id, item_type) dedup key would change every run and " +
				"itemsNew would never reach 0. Fixed by attaching items to the plain-text transcript document instead " +
				"(confirmed content-stable — see above), whose document_id does NOT change run to run. The plain-text doc's " +
				"ETag header also differs on HEAD requests, but its actual body content_hash is what matters for dedup and " +
				"that was verified stable across three separate fetches.",
		);
		ctx.note(
			`Bonus/out-of-scope finding (not acted on — outside this scraper's file ownership): /videos/<id>/agenda ` +
				"redirects to agendaquick.chinohills.org:8086/agenda_publish.cfm — a THIRD agenda backend for Chino Hills " +
				"(distinct from whatever chinohills.org/60/Agendas-Minutes uses for Task 0.4), worth a look when that task " +
				"is built. /videos/<id>/download redirects to a presigned S3 URL (granicus-aasmp-swagit-video bucket) for " +
				"the raw MP4 — confirms the video hosting backend but isn't used here.",
		);

		// --- 6. Volume bound and item insertion. ---
		let toStore = segments;
		if (segments.length > TRUNCATE_ABOVE) {
			toStore = segments.slice(0, MAX_SEGMENTS);
			ctx.note(
				`Volume bound: transcript has ${segments.length} segments, above the ~1500 threshold — storing only the ` +
					`first ${MAX_SEGMENTS} (chronological) and truncating the rest for this POC run.`,
			);
		} else {
			ctx.note(
				`Volume bound not triggered: ${segments.length} segments is under the ~1500 threshold — storing all of them.`,
			);
		}

		for (let i = 0; i < toStore.length; i++) {
			const seg = toStore[i];
			const startRounded = Math.round(seg.start);
			const sourceUrl = tsSupported
				? `${target.url}?ts=${startRounded}`
				: target.url;
			ctx.insertItem({
				document_id: itemsDocumentId,
				source_url: sourceUrl,
				item_type: "transcript_segment",
				external_id: `${vid}-${i}`,
				title: seg.text.length > 80 ? `${seg.text.slice(0, 77)}...` : seg.text,
				body: seg.text,
				occurred_at: meetingDate?.iso ?? null,
				meta: {
					videoId: Number(vid),
					startSeconds: seg.start,
					endSeconds: seg.end,
					segmentIndex: i,
				},
			});
		}
	},
};

export default scraper;
