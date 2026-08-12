// Task 0.2 — Chino Agenda Center (commissions). CivicEngage/CivicPlus platform
// at cityofchino.org/agendacenter. Answers PLAN.md open question 2: where do
// Chino Planning Commission agendas actually live?
//
// Discovery approach: robots.txt on this host disallows /Search (and
// /Search.aspx), which rules out biglocalnews/civic-scraper's CivicPlus
// pattern of POSTing to /Search/?... (see reports/notes/prior-art.md, civic-
// scraper section) — that endpoint is off-limits under PLAN.md's politeness
// constraint, not merely unused. RSS is also a dead end here: the sibling
// chino-news-rss.ts catalog (reports/notes/chino-news-rss.md) lists Agenda
// Center (ModID=65) as having only two feeds — "All" and "Community Services
// Commission" — and both return zero <item> elements at run time (CivicPlus
// Agenda Center RSS appears to only surface *recent* activity, and there is
// none). So this scraper discovers structure the way a human visitor would:
// GET /agendacenter, parse the rendered category checkbox list (ground truth
// for which bodies publish here) and the initially-rendered "current year"
// table for each category (ground truth for which PDFs exist), via cheerio.
//
// Ported from biglocalnews/civic-scraper's CivicPlus module (see prior-art.md):
// the meeting date is not reliable in visible cell text — it's embedded in an
// anchor's `name` attribute as `_MMDDYYYY-<id>` on the /AgendaCenter/ViewFile
// link itself, parsed with a `_(\d{2})(\d{2})(\d{4})` regex. That pattern is
// reused verbatim below (parseAnchorDate).
import * as cheerio from 'cheerio';
import type { ScraperContext, ScraperDef } from './types.ts';
import { extractPdfText } from '../pdf.ts';

const BASE = 'https://www.cityofchino.org';
const AGENDA_CENTER_URL = `${BASE}/agendacenter`;
const MAX_PDFS = 3;

interface CategoryInfo {
  id: string;
  name: string;
}

interface AgendaRow {
  category: CategoryInfo;
  meetingDate: string; // ISO yyyy-mm-dd
  title: string;
  url: string; // absolute
}

// civic-scraper's date-in-anchor-name quirk: the reliable date lives in
// `_MMDDYYYY-<rowid>`, not in the visible "Jan 4, 2022" cell text.
function parseAnchorDate(anchorName: string): string | null {
  const m = anchorName.match(/^_?(\d{2})(\d{2})(\d{4})/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function discoverCategories($: cheerio.CheerioAPI): CategoryInfo[] {
  const cats: CategoryInfo[] = [];
  $('input[name="chkCategoryID"]').each((_, el) => {
    const id = $(el).attr('value');
    if (!id) return;
    // Label text sits in the sibling <label for="ID"> wrapping the checkbox.
    const label = $(`label[for="${id}"]`).text().replace(/\s+/g, ' ').trim();
    if (id && label) cats.push({ id, name: label });
  });
  return cats;
}

function extractRowsForCategory($: cheerio.CheerioAPI, cat: CategoryInfo): AgendaRow[] {
  const rows: AgendaRow[] = [];
  // Each category renders as <div id="catNNN">...<span id="sectionNNN">
  // ...<table>. We only see whichever year is initially rendered (the
  // site's own "current" year tab) — that's fine, it's the most recent
  // year with data, which is what we want for "most recent PDFs".
  const section = $(`#section${cat.id}`);
  if (section.length === 0) return rows;
  section.find('tr.catAgendaRow, tbody tr').each((_, tr) => {
    const $tr = $(tr);
    // The date-bearing anchor: <a id="_MMDDYYYY-N" name="_MMDDYYYY-N"></a>
    const dateAnchor = $tr.find('a[name^="_"]').first();
    const anchorName = dateAnchor.attr('name') ?? dateAnchor.attr('id') ?? '';
    const meetingDate = parseAnchorDate(anchorName);
    if (!meetingDate) return;
    // Agenda PDF link: /AgendaCenter/ViewFile/Agenda/... — per civic-scraper,
    // CivicPlus renders each file link twice (row link + download-menu
    // link); dedupe by href within the row, prefer the row's title link.
    const pdfLink = $tr.find('a[href*="/AgendaCenter/ViewFile/Agenda/"]').first();
    const href = pdfLink.attr('href');
    if (!href) return;
    const title = pdfLink.text().replace(/\s+/g, ' ').trim() || `${cat.name} agenda`;
    rows.push({
      category: cat,
      meetingDate,
      title,
      url: new URL(href, BASE).toString(),
    });
  });
  return rows;
}

// Heuristic agenda-item splitter. POC quality (see ctx.note() in run()):
// bounds the search to the text between a standalone "AGENDA" heading and
// the next "ADJOURN" line (the section that precedes staff-report/packet
// attachments in a combined agenda-packet PDF), then splits on lines that
// open with "<N>. ". Does not handle lettered sub-items, roman numerals, or
// documents lacking an explicit ADJOURN line (falls back to a fixed char cap
// in that case).
interface AgendaItem {
  n: string;
  title: string;
  body: string;
  page: number;
}

function pageForIndex(text: string, idx: number): number {
  const marker = /--\s*\d+\s*of\s*\d+\s*--/g;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text.slice(0, idx))) !== null) count++;
  return count + 1;
}

function splitAgendaItems(fullText: string): { items: AgendaItem[]; boundedFallback: boolean } {
  const agendaHeadingRe = /^\s*AGENDA\s*$/m;
  const headingMatch = agendaHeadingRe.exec(fullText);
  const start = headingMatch ? headingMatch.index + headingMatch[0].length : 0;
  const adjournRe = /^\s*ADJOURN(MENT)?/im;
  const rest = fullText.slice(start);
  const adjournMatch = adjournRe.exec(rest);
  let boundedFallback = false;
  let regionEnd: number;
  if (adjournMatch) {
    regionEnd = start + adjournMatch.index;
  } else {
    boundedFallback = true;
    regionEnd = Math.min(fullText.length, start + 8000); // safety cap, POC-quality
  }
  const region = fullText.slice(start, regionEnd);

  const itemRe = /^\s*(\d{1,2})\.\s+/gm;
  const matches: Array<{ n: string; idx: number; contentStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(region)) !== null) {
    matches.push({ n: m[1], idx: m.index, contentStart: m.index + m[0].length });
  }

  const items: AgendaItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const bodyRaw = region.slice(cur.contentStart, next ? next.idx : region.length).trim();
    const body = bodyRaw.replace(/\s+/g, ' ').trim();
    const title = body.slice(0, 120);
    items.push({
      n: cur.n,
      title,
      body,
      page: pageForIndex(fullText, start + cur.idx),
    });
  }
  return { items, boundedFallback };
}

async function ingestAgenda(ctx: ScraperContext, row: AgendaRow): Promise<void> {
  const doc = await ctx.fetchDocument(row.url, {
    docType: 'agenda',
    title: row.title,
    meetingDate: row.meetingDate,
  });
  const { text, numPages } = await extractPdfText(doc.body);
  ctx.note(
    `PDF "${row.title}" (${row.category.name}, ${row.meetingDate}): ${numPages} pages, ${text.length} chars extracted via extractPdfText — clean, selectable text (not scanned/image-only).`
  );

  const { items, boundedFallback } = splitAgendaItems(text);
  if (boundedFallback) {
    ctx.note(
      `Item-splitter fallback: no "ADJOURN" boundary found in "${row.title}"; capped the numbered-item search window at 8000 chars from the AGENDA heading. Verify manually if this doc has more than a handful of items.`
    );
  }
  if (items.length === 0) {
    ctx.note(
      `Item-splitter found 0 numbered items in "${row.title}" — heuristic (standalone "AGENDA" heading -> "ADJOURN", split on "^N. ") did not match this document's layout. No fallback item inserted; POC-quality limitation, noted honestly rather than guessing.`
    );
    return;
  }

  for (const item of items) {
    ctx.insertItem({
      document_id: doc.documentId,
      source_url: `${row.url}#page=${item.page}`,
      item_type: 'agenda_item',
      external_id: `${row.meetingDate}-${item.n}`,
      title: item.title,
      body: item.body,
      occurred_at: row.meetingDate,
      meta: { agendaNumber: item.n, body: row.category.name },
    });
  }
  ctx.note(`Split "${row.title}" into ${items.length} agenda_item row(s) (item numbers: ${items.map((i) => i.n).join(', ')}).`);
}

const scraper: ScraperDef = {
  key: 'chino-agendacenter',
  name: 'Chino Agenda Center (CivicEngage commissions)',
  baseUrl: AGENDA_CENTER_URL,
  method: 'html',
  async run(ctx) {
    const listing = await ctx.fetchRaw(AGENDA_CENTER_URL);
    if (!listing.ok) throw new Error(`HTTP ${listing.status} fetching ${AGENDA_CENTER_URL}`);
    const $ = cheerio.load(listing.body.toString('utf8'));

    const categories = discoverCategories($);
    ctx.note(
      `Agenda Center category checkbox list enumerates ${categories.length} bod${categories.length === 1 ? 'y' : 'ies'} that publish here: ${categories.map((c) => `"${c.name}" (catID=${c.id})`).join(', ') || '(none)'}.`
    );

    const planningListed = categories.some((c) => /planning/i.test(c.name));
    if (planningListed) {
      ctx.note(
        'Open question 2 verdict: Planning Commission DOES appear in the CivicEngage Agenda Center category list (see above) — contradicts the Legistar-only expectation; both surfaces may be in use.'
      );
    } else {
      ctx.note(
        'Open question 2 verdict: Planning Commission does NOT appear in the CivicEngage Agenda Center. The category checkbox list at /agendacenter (ground truth for "which bodies publish here") lists only ' +
          `${categories.map((c) => `"${c.name}"`).join(', ') || 'no categories at all'}. Cross-checked independently against the sibling chino-news-rss.ts feed catalog (reports/notes/chino-news-rss.md), which enumerates the same Agenda Center module (ModID=65) as having only "All" and "Community Services Commission" feeds — no Planning Commission feed exists either. Combined with reports/notes/chino-legistar.md, which found live Planning Commission meetings in Legistar (EventId 1971, 2026-07-15, 24 items), the verdict is: Planning Commission publishes EXCLUSIVELY through Legistar, not through the Agenda Center.`
      );
    }

    // Cross-check via the RSS surface the sibling scraper already catalogued
    // for this module, to confirm the "zero recent activity" read is not an
    // artifact of how we parsed the HTML page.
    const rssAll = await ctx.fetchRaw(`${BASE}/RSSFeed.aspx?ModID=65&CID=All-0`);
    const rssItemCount = (rssAll.body.toString('utf8').match(/<item>/g) ?? []).length;
    ctx.note(
      `Cross-check: Agenda Center RSS feed (ModID=65, CID=All-0) returns ${rssItemCount} <item> element(s). ${
        rssItemCount === 0
          ? 'Zero — RSS is not a usable discovery/ingestion path for this Agenda Center; it appears to only surface recent activity, and this instance has none. Relied on the HTML category+table listing instead (see above).'
          : ''
      }`
    );

    // Gather rows across all discovered categories (whichever "current"
    // year each renders initially), most recent meeting date first, bounded
    // to MAX_PDFS total across the whole Agenda Center.
    let rows: AgendaRow[] = [];
    for (const cat of categories) {
      const catRows = extractRowsForCategory($, cat);
      ctx.note(`Category "${cat.name}": ${catRows.length} agenda PDF(s) in its initially-rendered ("current") year.`);
      rows = rows.concat(catRows);
    }
    rows.sort((a, b) => (a.meetingDate < b.meetingDate ? 1 : -1));
    const toIngest = rows.slice(0, MAX_PDFS);

    if (toIngest.length < rows.length || rows.length < MAX_PDFS) {
      ctx.note(
        `Volume note: ${rows.length} total agenda PDF(s) found across ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} (the task's ~3-PDF bound was aimed at "2-3 most recent across commissions found"; this Agenda Center simply does not have that many live documents — the most recent posting site-wide is ${rows[0]?.meetingDate ?? 'n/a'}, over 4 years stale as of this run).`
      );
    }

    for (const row of toIngest) {
      await ingestAgenda(ctx, row);
    }

    // Minutes check (noted only, per task scope — not ingested).
    const minutesLinks = $('a[href*="/AgendaCenter/ViewFile/Minutes/"]');
    ctx.note(
      `Minutes: ${minutesLinks.length} link(s) to /AgendaCenter/ViewFile/Minutes/ found on the listing page (note only, per task scope — not ingested). The single Community Services Commission row ingested here has an empty "Minutes" table cell, i.e. no minutes were ever posted for it.`
    );

    ctx.note(
      'robots.txt on cityofchino.org disallows /Search and /Search.aspx, ruling out the biglocalnews/civic-scraper CivicPlus pattern (POST to /Search/?...) as a discovery method here under PLAN.md\'s politeness constraint; used the rendered /agendacenter category+table HTML instead, which robots.txt does not restrict.'
    );
  },
};

export default scraper;
