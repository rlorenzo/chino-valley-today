// Task 0.9 (Chino Hills half) — San Bernardino County Sheriff news releases.
//
// PLAN.md's guess (wp.sbcounty.gov/sheriff/news/feed/) is stale — 404. Live probe log
// (curl, 2026-08-11/12) below; see reports/notes/sbsheriff-news.md for the full
// narrative. Short version:
//
//   https://wp.sbcounty.gov/sheriff/news/feed/                              -> 404
//   https://wp.sbcounty.gov/sheriff/news/                                   -> 404
//   https://wp.sbcounty.gov/sheriff/                                        -> 200 (real site root)
//   https://wp.sbcounty.gov/sheriff/feed/                                   -> 200, valid RSS 2.0,
//                                                                              but <channel> has ZERO
//                                                                              <item>s (confirmed via
//                                                                              wp-json/wp/v2/posts:
//                                                                              X-WP-Total: 0 — the
//                                                                              WordPress "post" content
//                                                                              type is entirely empty).
//   https://wp.sbcounty.gov/sheriff/wp-json/wp/v2/categories                -> a full station/month/year
//                                                                              taxonomy exists (incl.
//                                                                              slug "chino-hills"), every
//                                                                              term count:0 — press
//                                                                              releases used to be WP
//                                                                              posts (categories go back
//                                                                              to ~2015) but that stopped;
//                                                                              the taxonomy is a fossil.
//   https://wp.sbcounty.gov/sheriff/media-center/sheriffs-press-releases/   -> 200, but it is a card
//                                                                              directory ("Press Releases
//                                                                              By Category"), not a
//                                                                              listing of releases. Every
//                                                                              card except "Coroner"
//                                                                              (incl. "Chino Hills")
//                                                                              target="_blank"s out to a
//                                                                              per-station Nixle channel,
//                                                                              e.g. Chino Hills ->
//                                                                              https://local.nixle.com/sbsd---chino-hills-police-department/.
//                                                                              /sheriff/patrol-stations/chino-hills/
//                                                                              independently confirms this
//                                                                              (prominent Nixle badge,
//                                                                              linking to the same URL, no
//                                                                              on-site news content).
//   https://wp.sbcounty.gov/sheriff/media-center/coroner-press-release/     -> 200, and — unlike every
//                                                                              other category — this one
//                                                                              IS live content: a plain
//                                                                              WordPress *page* (not the
//                                                                              empty "post" type) with ~60
//                                                                              case entries embedded
//                                                                              directly in the page body.
//                                                                              County-wide (Sheriff-Coroner
//                                                                              is one department in SB
//                                                                              County), not station-tagged,
//                                                                              and zero "Chino Hills"
//                                                                              mentions in the current
//                                                                              window (checked by hand).
//
// VERDICT — RSS: technically present (/sheriff/feed/, standard WordPress feed) but
// structurally empty; not usable for press releases in their current form.
// VERDICT — station taxonomy: exists (WP categories, incl. a real "Chino Hills" term)
// but is dead — zero posts use it. The *live* per-station channel is Nixle, one URL
// per station, referenced from both the press-release directory page and the
// station's own page.
//
// Nixle disposition: local.nixle.com/sbsd---chino-hills-police-department/ was
// inspected (not scraped) to characterize it for this report — see
// reports/notes/sbsheriff-news.md. It is real, current, per-station content (~20
// items/page, paginated, absolute timestamps and full text on each message's
// permalink) and its robots.txt does not block it, but it is a third-party
// citizen-notification platform, not a Sheriff's Department–operated page — the
// same category of source Task 0.9's own instructions call out for Chino PD
// ("If PD has a separate Nixle/social-only channel, note it as a gap rather than
// scraping social platforms"). Applying that same policy here: Nixle is
// deliberately NOT ingested by this scraper. Each run does a single lightweight,
// best-effort HEAD-weight fetch of the channel's public page purely to report a
// live item count in ctx.note() (cadence signal for the product), never inserted
// as items.
//
// Fallback per Task 0.9 instructions: since zero Chino Hills-tagged/matching
// releases exist in the only live non-Nixle source, the 5 most recent county-wide
// Coroner press releases are ingested instead, clearly marked non-Chino-Hills-
// specific, so the pipeline has real sample data end to end.

import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { ScraperContext, ScraperDef } from './types.ts';

const BASE = 'https://wp.sbcounty.gov/sheriff';
const CORONER_URL = `${BASE}/media-center/coroner-press-release/`;
const PRESS_RELEASES_DIRECTORY_URL = `${BASE}/media-center/sheriffs-press-releases/`;
const CHINO_HILLS_STATION_URL = `${BASE}/patrol-stations/chino-hills/`;
const FEED_URL = `${BASE}/feed/`;
const NIXLE_CHINO_HILLS_URL = 'https://local.nixle.com/sbsd---chino-hills-police-department/';

const CHINO_HILLS_RE = /chino hills/i;
const MAX_FALLBACK_ITEMS = 5;

function stripHtml(input: string | undefined | null): string {
  if (!input) return '';
  return cheerio.load(`<div>${input}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

// --- Pacific-time parsing for coroner release text ("On Sunday, 07/26/2026, at
// 09:54 p.m., ..."). Sheriff/Coroner releases only ever carry local (Pacific)
// clock time, no offset — this reconstructs the UTC instant using the standard
// US DST rule (2nd Sunday of March -> 1st Sunday of November), computed
// generically so it stays correct for whatever year the scraper runs in. Known
// POC-level imprecision: the ~2am local switchover boundary on the transition
// days themselves is treated as day-granular, not hour-granular.
function nthSundayOfMonth(year: number, month1to12: number, n: number): number {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const offsetToFirstSunday = (7 - first.getUTCDay()) % 7;
  return 1 + offsetToFirstSunday + (n - 1) * 7;
}

function isPacificDst(year: number, month1to12: number, day: number): boolean {
  if (month1to12 < 3 || month1to12 > 11) return false;
  if (month1to12 > 3 && month1to12 < 11) return true;
  if (month1to12 === 3) return day >= nthSundayOfMonth(year, 3, 2);
  return day < nthSundayOfMonth(year, 11, 1); // month === 11
}

function pacificToIso(year: number, month1to12: number, day: number, hour24: number, minute: number): string {
  const offsetHours = isPacificDst(year, month1to12, day) ? 7 : 8;
  const utcMs = Date.UTC(year, month1to12 - 1, day, hour24, minute) + offsetHours * 3600 * 1000;
  return new Date(utcMs).toISOString();
}

const CORONER_DATE_RE = /On\s+\w+day,\s*(\d{2})\/(\d{2})\/(\d{4}),\s*at\s*(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.)/i;

function extractOccurredAt(body: string): string | null {
  const m = CORONER_DATE_RE.exec(body);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, min, ampm] = m;
  let hour = parseInt(hh, 10) % 12;
  if (/p\.m\./i.test(ampm)) hour += 12;
  return pacificToIso(parseInt(yyyy, 10), parseInt(mm, 10), parseInt(dd, 10), hour, parseInt(min, 10));
}

interface CoronerItem {
  externalId: string;
  body: string;
}

function parseCoronerItems($: cheerio.CheerioAPI): CoronerItem[] {
  const items: CoronerItem[] = [];
  $('ul.wp-block-list > li').each((_, el) => {
    const $li = $(el);
    const strongText = $li.find('strong').first().text().trim();
    const idMatch = /^(\d+):$/.exec(strongText);
    if (!idMatch) return; // defensive: skip anything not matching the case-number pattern
    const fullText = $li.text().replace(/\s+/g, ' ').trim();
    items.push({ externalId: idMatch[1], body: fullText });
  });
  return items;
}

// Mirrors chinohills-news-rss.ts's resolveDocumentId(): the coroner page's list
// rotates (new deaths added, old ones roll off) so its content_hash — and
// therefore its documents row — changes most runs. Items must stay pinned to
// whichever document_id first captured their external_id, or every surviving
// item looks "new" again on every re-run.
function resolveDocumentId(ctx: ScraperContext, freshDocumentId: number, externalId: string, itemType: string): number {
  const row = ctx.db.raw
    .prepare(
      `SELECT i.document_id AS documentId FROM items i
       JOIN documents d ON i.document_id = d.id
       WHERE i.external_id = ? AND i.item_type = ? AND d.source_id = ?
       ORDER BY i.id DESC LIMIT 1`
    )
    .get(externalId, itemType, ctx.sourceId) as { documentId: number } | undefined;
  return row?.documentId ?? freshDocumentId;
}

async function run(ctx: ScraperContext): Promise<void> {
  // --- Probe pass: document every URL tried, per Task 0.9 requirements ---
  const probe = async (url: string, label: string) => {
    try {
      const r = await ctx.fetchRaw(url);
      ctx.note(`Probe: ${label} (${url}) -> HTTP ${r.status}`);
      return r;
    } catch (err) {
      ctx.note(`Probe: ${label} (${url}) -> error: ${(err as Error).message}`);
      return null;
    }
  };

  await probe(`${BASE}/news/feed/`, "PLAN.md's guessed URL");
  await probe(`${BASE}/news/`, 'PLAN.md guess without /feed/');
  await probe(`${BASE}/`, 'Sheriff site root');

  // RawResult doesn't expose arbitrary response headers (no generic headers
  // map), so X-WP-Total can't be read from fetchRaw here; it was inspected once
  // out of band during research (curl -D -, see file header comment: 0 posts).
  // This run's probe just confirms the endpoint still answers and the returned
  // array is still empty, so a future run notices if that ever changes.
  const postsProbe = await ctx.fetchRaw(`${BASE}/wp-json/wp/v2/posts?per_page=5`);
  let postsCount: number | null = null;
  if (postsProbe.ok) {
    try {
      postsCount = (JSON.parse(postsProbe.body.toString('utf8')) as unknown[]).length;
    } catch {
      // ignore parse failure; postsCount stays null
    }
  }
  ctx.note(
    `Probe: WP REST API posts (${BASE}/wp-json/wp/v2/posts?per_page=5) -> HTTP ${postsProbe.status}, ${postsCount ?? 'unparseable'} post(s) returned (out-of-band curl confirmed X-WP-Total: 0 on 2026-08-11/12 — the WordPress "post" content type is entirely empty).`
  );

  const categoriesProbe = await ctx.fetchRaw(`${BASE}/wp-json/wp/v2/categories?per_page=100&search=chino`);
  let chinoHillsCategoryFound = false;
  let chinoHillsCategoryCount: number | null = null;
  if (categoriesProbe.ok) {
    try {
      const cats = JSON.parse(categoriesProbe.body.toString('utf8')) as Array<{ slug: string; name: string; count: number }>;
      const hit = cats.find((c) => c.slug === 'chino-hills');
      if (hit) {
        chinoHillsCategoryFound = true;
        chinoHillsCategoryCount = hit.count;
      }
    } catch {
      // ignore parse failure; noted below via the found/count still being null
    }
  }
  ctx.note(
    `Station taxonomy verdict: WordPress category "Chino Hills" (slug chino-hills) ${
      chinoHillsCategoryFound ? `exists, post count = ${chinoHillsCategoryCount}` : 'was not found'
    }. The full category list (checked out-of-band) also has dead per-month/per-year categories back to 2015 — press releases used to be WP posts categorized by station and date; that mechanism is no longer populated (WP posts total = 0, confirmed via /wp-json/wp/v2/posts -> X-WP-Total header).`
  );

  // --- RSS check: /sheriff/feed/ exists and is valid RSS, but is empty ---
  const feedDoc = await ctx.fetchDocument(FEED_URL, { docType: 'feed', title: 'SB Sheriff site-wide RSS feed' });
  const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let feedItemCount = 0;
  try {
    const parsed = xmlParser.parse(feedDoc.body.toString('utf8')) as Record<string, unknown>;
    const rss = parsed?.rss as Record<string, unknown> | undefined;
    const channel = rss?.channel as Record<string, unknown> | undefined;
    const rawItems = channel?.item;
    feedItemCount = rawItems == null ? 0 : Array.isArray(rawItems) ? rawItems.length : 1;
  } catch (err) {
    ctx.note(`Feed at ${FEED_URL} failed to parse as RSS: ${(err as Error).message}`);
  }
  ctx.note(
    `RSS verdict: ${FEED_URL} returns HTTP 200 with a valid WordPress RSS 2.0 channel, but it currently contains ${feedItemCount} <item>(s). Not usable for press-release ingestion in its current state — the site's "post" content type is empty.`
  );

  // --- Press-release directory page: confirms Nixle routing per station ---
  const directoryDoc = await ctx.fetchDocument(PRESS_RELEASES_DIRECTORY_URL, {
    docType: 'listing',
    title: "Sheriff's Press Releases (category directory)",
  });
  const $directory = cheerio.load(directoryDoc.body.toString('utf8'));
  const chinoHillsCard = $directory('a[aria-label="Chino Hills"]').first();
  const chinoHillsCardHref = chinoHillsCard.attr('href') ?? null;
  const chinoHillsCardTarget = chinoHillsCard.attr('target') ?? null;
  ctx.note(
    `Press-release directory page (${PRESS_RELEASES_DIRECTORY_URL}) is a card grid of categories, not a release listing. Every card except "Coroner" routes off-site (target="_blank") to a per-station Nixle channel. Chino Hills card -> href="${chinoHillsCardHref}" target="${chinoHillsCardTarget}".`
  );

  // Corroborating check: the Chino Hills station's own page also just badges out
  // to the same Nixle channel, no on-site news content.
  const stationDoc = await ctx.fetchDocument(CHINO_HILLS_STATION_URL, { docType: 'listing', title: 'Chino Hills patrol station page' });
  const $station = cheerio.load(stationDoc.body.toString('utf8'));
  const stationNixleHref = $station('a[href*="nixle"]').first().attr('href') ?? null;
  ctx.note(
    `Chino Hills patrol station page (${CHINO_HILLS_STATION_URL}) corroborates the directory: its "Nixle" badge links to ${stationNixleHref ?? '(not found)'}, and the page has no embedded news content of its own.`
  );

  // --- Nixle disposition: inspect only (best-effort, never ingested) ---
  try {
    const nixleRaw = await ctx.fetchRaw(NIXLE_CHINO_HILLS_URL);
    if (nixleRaw.ok) {
      const $nixle = cheerio.load(nixleRaw.body.toString('utf8'));
      const liveItemCount = $nixle('ol#wire > li').length;
      ctx.note(
        `Nixle disposition (NOT ingested — third-party citizen-notification platform, same policy as the Chino PD "Nixle/social-only channel" carve-out in Task 0.9): the Chino Hills station's live Nixle channel (${NIXLE_CHINO_HILLS_URL}) currently shows ${liveItemCount} message(s) on its first page (paginated, ~20/page; robots.txt on local.nixle.com/nixle.us does not block this path, only /region_search/ and /agency_search/). Sampled one message permalink (nixle.us short link) during research: full text and an absolute Pacific timestamp ("Thursday July 16th, 2026 :: 10:38 a.m. PDT") are present on the detail page — technically ingestable if a future product decision reverses this policy. Cadence signal for the product: this is the ONLY channel currently carrying Chino Hills-specific Sheriff station news.`
      );
    } else {
      ctx.note(`Nixle disposition: channel page returned HTTP ${nixleRaw.status}; skipping the cadence count for this run.`);
    }
  } catch (err) {
    ctx.note(`Nixle disposition: best-effort cadence check failed (${(err as Error).message}); not fetched via fetchDocument, nothing archived, no impact on ingestion.`);
  }

  // --- Coroner press releases: the one live, non-Nixle, current source ---
  const coronerDoc = await ctx.fetchDocument(CORONER_URL, { docType: 'news_release', title: 'San Bernardino County Coroner press releases' });
  const $coroner = cheerio.load(coronerDoc.body.toString('utf8'));
  const coronerItems = parseCoronerItems($coroner);
  ctx.note(
    `Coroner press releases page (${CORONER_URL}) is the only live, current, non-Nixle release content on wp.sbcounty.gov/sheriff: a WordPress *page* (not the empty "post" type) with ${coronerItems.length} case entries embedded directly in the body as a flat list, most-recent first. San Bernardino County's Sheriff and Coroner are one department (Sheriff-Coroner), so this is in-scope as county-wide Sheriff-adjacent content, but it is NOT station-tagged and covers the whole county, not just Chino Hills.`
  );

  const chinoHillsMatches = coronerItems.filter((it) => CHINO_HILLS_RE.test(it.body));
  ctx.note(
    `Chino Hills relevance check on the Coroner feed: ${chinoHillsMatches.length} of ${coronerItems.length} current entries mention "Chino Hills" in the body text.`
  );

  let toIngest: CoronerItem[];
  if (chinoHillsMatches.length > 0) {
    toIngest = chinoHillsMatches;
  } else {
    toIngest = coronerItems.slice(0, MAX_FALLBACK_ITEMS);
    ctx.note(
      `ZERO Chino Hills-tagged/matching Sheriff releases found in the only ingestable (non-Nixle) source in this run's window. Falling back to the ${toIngest.length} most recent county-wide Coroner press release(s) so the pipeline is demonstrated end to end. This is a real product gap, not a scraper bug: Chino Hills station-specific Sheriff news currently lives exclusively on Nixle (see the Nixle disposition note above) and is not ingested by policy.`
    );
  }

  // --- Data-quality note: no per-item permalink exists on this page ---
  ctx.note(
    `Link-back depth: the Coroner press-release page has NO per-item anchor or permalink — all entries share one page URL (${CORONER_URL}). source_url for every item below points at that shared page (document-level link-back, not item-level). This also means historical entries roll off the page over time with no on-site archive; external_id (the numeric case number embedded in the source text) is the only handle for idempotency across runs.`
  );

  let missingDatePattern = 0;
  for (const item of toIngest) {
    const occurredAt = extractOccurredAt(item.body);
    if (!occurredAt) missingDatePattern++;
    const title = `Coroner press release ${item.externalId}`;
    ctx.insertItem({
      document_id: resolveDocumentId(ctx, coronerDoc.documentId, item.externalId, 'news_release'),
      source_url: CORONER_URL,
      item_type: 'news_release',
      external_id: item.externalId,
      title,
      body: item.body,
      occurred_at: occurredAt,
      meta: {
        category: 'coroner',
        stationTag: null,
        chinoHillsRelevant: CHINO_HILLS_RE.test(item.body),
        listingUrl: CORONER_URL,
        feedUrl: null,
      },
    });
  }
  if (missingDatePattern > 0) {
    ctx.note(`${missingDatePattern} of ${toIngest.length} ingested coroner item(s) did not match the expected "On <Weekday>, MM/DD/YYYY, at H:MM a.m./p.m." date pattern; occurred_at left null for those.`);
  }

  // --- Tier C privacy caveat (per Task 0.9 / PLAN.md Tier C design) ---
  ctx.note(
    'Tier C privacy caveat: Coroner press release bodies name private individuals (decedents) by full name, age, and city of residence, and at least one entry in the current window names a minor (age 16). This is stored verbatim/faithfully per PLAN.md\'s Tier C design (crime/death items naming private individuals or minors always require human review before publishing — no filtering, redaction, or editorializing performed here; that is the whole point of the Tier C gate, not a scraper concern).'
  );

  // --- HTTP behavior notes ---
  ctx.note(
    `HTTP behavior: robots.txt on wp.sbcounty.gov only disallows /wp-admin/ (with an explicit Allow for admin-ajax.php) — nothing in this scraper's path is blocked, so no skipRobots use was needed anywhere. ${FEED_URL} sends both ETag and Last-Modified (W3 Total Cache page caching) and supports conditional GET. ${CORONER_URL} and ${PRESS_RELEASES_DIRECTORY_URL} send only Cache-Control: max-age=3600, no ETag/Last-Modified — this fetcher's content-hash dedup in insertDocument is the only idempotency mechanism for those pages, which is why resolveDocumentId() (borrowed pattern, see chinohills-news-rss.ts) pins items to whichever document_id first captured their external_id.`
  );
  ctx.note('Full-text vs teaser: N/A in the RSS sense (the feed is empty) — the Coroner page embeds full release text directly in the page body, no separate detail page or teaser/full split exists for this source.');
}

const scraper: ScraperDef = {
  key: 'sbsheriff-news',
  name: 'San Bernardino County Sheriff News Releases (Chino Hills station)',
  baseUrl: BASE,
  method: 'html',
  run,
};

export default scraper;
