// Meeting bundle assembly: gather everything the DB knows about one meeting
// (agenda items, votes, transcript segments) into a synthesis input whose
// every element carries a source_url. The bundle is the ONLY material the
// generator may draw from, and its URL set is the only citable set.
import type { Db } from '../db/index.ts';
import { isoWeekOf } from '../tiera/util.ts';

export interface BundleItem {
  title: string | null;
  body: string | null;
  sourceUrl: string;
  meta: Record<string, unknown>;
  occurredAt: string | null;
}

export interface MeetingBundle {
  targetKey: string; // e.g. 'chino-legistar:2026-07-21'
  sourceKey: string;
  bodyName: string;
  meetingDate: string; // ISO date
  agendaItems: BundleItem[];
  votes: BundleItem[];
  transcriptSegments: BundleItem[];
  allowedUrls: string[];
  inputCorpus: string;
}

interface RawItemRow {
  item_type: string;
  title: string | null;
  body: string | null;
  source_url: string;
  meta: string | null;
  occurred_at: string | null;
}

function toBundleItem(r: RawItemRow): BundleItem {
  let meta: Record<string, unknown> = {};
  if (r.meta) {
    try {
      meta = JSON.parse(r.meta) as Record<string, unknown>;
    } catch {
      // leave empty
    }
  }
  return { title: r.title, body: r.body, sourceUrl: r.source_url, meta, occurredAt: r.occurred_at };
}

function itemsFor(db: Db, sourceKey: string, itemType: string, isoDate: string): BundleItem[] {
  const rows = db.raw
    .prepare(
      `SELECT i.item_type, i.title, i.body, i.source_url, i.meta, i.occurred_at
       FROM items i JOIN documents d ON i.document_id = d.id JOIN sources s ON d.source_id = s.id
       WHERE s.key = ? AND i.item_type = ? AND substr(COALESCE(i.occurred_at, d.meeting_date, ''), 1, 10) = ?
       ORDER BY i.id`
    )
    .all(sourceKey, itemType, isoDate) as unknown as RawItemRow[];
  return rows.map(toBundleItem);
}

// A recap target = a (city bundle) where at least an agenda or a transcript
// exists for the date. Transcript and agenda sources differ per city, so each
// target declares which source keys feed which section.
const TARGET_SHAPES: Array<{
  sourceKey: string; // primary key used in targetKey + display
  bodyName: string; // default; refined from agenda-item meta when available
  cityPrefix?: string;
  agenda: { key: string; type: string } | null;
  votes: { key: string; type: string } | null;
  transcript: { key: string; type: string } | null;
}> = [
  {
    sourceKey: 'chino-legistar',
    bodyName: 'Chino City Council',
    cityPrefix: 'Chino',
    agenda: { key: 'chino-legistar', type: 'agenda_item' },
    votes: { key: 'chino-legistar', type: 'vote' },
    transcript: { key: 'chino-youtube-captions', type: 'transcript_segment' }, // chinotv3 channel
  },
  {
    sourceKey: 'chinohills-swagit',
    bodyName: 'Chino Hills City Council',
    cityPrefix: 'Chino Hills',
    agenda: { key: 'chinohills-agendas', type: 'agenda_item' },
    votes: null, // Chino Hills votes are in minutes (robots-blocked Laserfiche)
    transcript: { key: 'chinohills-swagit', type: 'transcript_segment' },
  },
  {
    sourceKey: 'youtube-captions',
    bodyName: 'CVUSD Board of Education',
    agenda: { key: 'cvusd-board', type: 'agenda_item' }, // empty today (robots-blocked PDFs); listing events excluded — not agenda content
    votes: null,
    transcript: { key: 'youtube-captions', type: 'transcript_segment' },
  },
];

export function listRecapTargets(db: Db): Array<{ targetKey: string; bodyName: string; meetingDate: string; counts: Record<string, number> }> {
  const out: Array<{ targetKey: string; bodyName: string; meetingDate: string; counts: Record<string, number> }> = [];
  for (const shape of TARGET_SHAPES) {
    const dateRows = db.raw
      .prepare(
        `SELECT DISTINCT substr(COALESCE(i.occurred_at, d.meeting_date, ''), 1, 10) AS day
         FROM items i JOIN documents d ON i.document_id = d.id JOIN sources s ON d.source_id = s.id
         WHERE s.key IN (?, ?, ?) AND i.item_type IN ('agenda_item','transcript_segment')
           AND day != '' ORDER BY day DESC`
      )
      .all(
        shape.agenda?.key ?? shape.sourceKey,
        shape.transcript?.key ?? shape.sourceKey,
        shape.sourceKey
      ) as unknown as Array<{ day: string }>;
    for (const { day } of dateRows) {
      const bundle = assembleBundle(db, shape.sourceKey, day);
      if (!bundle) continue;
      if (bundle.agendaItems.length === 0 && bundle.transcriptSegments.length === 0) continue;
      out.push({
        targetKey: bundle.targetKey,
        bodyName: bundle.bodyName,
        meetingDate: day,
        counts: {
          agendaItems: bundle.agendaItems.length,
          votes: bundle.votes.length,
          transcriptSegments: bundle.transcriptSegments.length,
        },
      });
    }
  }
  return out;
}

export function assembleBundle(db: Db, sourceKey: string, isoDate: string): MeetingBundle | null {
  const shape = TARGET_SHAPES.find((s) => s.sourceKey === sourceKey);
  if (!shape) return null;
  const agendaItems = shape.agenda ? itemsFor(db, shape.agenda.key, shape.agenda.type, isoDate) : [];
  const votes = shape.votes ? itemsFor(db, shape.votes.key, shape.votes.type, isoDate) : [];
  const transcriptSegments = shape.transcript
    ? itemsFor(db, shape.transcript.key, shape.transcript.type, isoDate)
    : [];
  if (agendaItems.length === 0 && transcriptSegments.length === 0) return null;

  // The shape's bodyName is a default: a date can belong to a different body
  // on the same platform (Legistar hosts Planning Commission too), so prefer
  // the body name the agenda items themselves carry.
  let bodyName = shape.bodyName;
  const metaBody = agendaItems[0]?.meta.eventBodyName ?? agendaItems[0]?.meta.body;
  if (typeof metaBody === 'string' && metaBody.trim()) {
    const name = metaBody.trim();
    bodyName = shape.cityPrefix && !name.toLowerCase().includes(shape.cityPrefix.toLowerCase())
      ? `${shape.cityPrefix} ${name}`
      : name;
  }

  const allowedUrls = [
    ...new Set([...agendaItems, ...votes, ...transcriptSegments].map((i) => i.sourceUrl)),
  ];
  const corpusParts: string[] = [bodyName, isoDate];
  for (const it of [...agendaItems, ...votes, ...transcriptSegments]) {
    if (it.title) corpusParts.push(it.title);
    if (it.body) corpusParts.push(it.body);
    for (const v of Object.values(it.meta)) {
      if (typeof v === 'string' || typeof v === 'number') corpusParts.push(String(v));
    }
  }
  return {
    targetKey: `${shape.sourceKey}:${isoDate}`,
    sourceKey: shape.sourceKey,
    bodyName,
    meetingDate: isoDate,
    agendaItems,
    votes,
    transcriptSegments,
    allowedUrls,
    inputCorpus: corpusParts.join('\n'),
  };
}

// Render the bundle as the generator's user-message payload: numbered source
// list up front, then sections. Sources are the contract — the prompt forbids
// citing anything else.
export function renderBundleForPrompt(b: MeetingBundle, opts: { maxTranscriptChars?: number } = {}): string {
  const lines: string[] = [];
  lines.push(`# Meeting: ${b.bodyName} — ${b.meetingDate}`);
  lines.push(
    '',
    '## Citable source URLs (the ONLY URLs you may link; cite as inline markdown links, never shorthand):'
  );
  b.allowedUrls.forEach((u) => lines.push(`- ${u}`));

  if (b.agendaItems.length) {
    lines.push('', '## Agenda items (verbatim):');
    for (const it of b.agendaItems) {
      lines.push(`- ${it.title ?? '(untitled)'}${it.meta.agendaNumber ? ` [item ${it.meta.agendaNumber}]` : ''}`);
      lines.push(`  source: ${it.sourceUrl}`);
      if (it.body) lines.push(`  detail: ${it.body.slice(0, 500)}`);
      const action = it.meta.actionText ?? it.meta.passedFlag;
      if (action !== undefined && action !== null) lines.push(`  action: ${String(action)}`);
    }
  }
  if (b.votes.length) {
    lines.push('', '## Recorded votes:');
    for (const v of b.votes) {
      lines.push(`- ${v.title ?? ''} ${JSON.stringify(v.meta)}`);
      lines.push(`  source: ${v.sourceUrl}`);
    }
  }
  if (b.transcriptSegments.length) {
    lines.push('', '## Transcript (machine-generated; names may be misrecognized — never introduce a name that appears ONLY here):');
    const cap = opts.maxTranscriptChars ?? 400_000;
    let used = 0;
    for (const t of b.transcriptSegments) {
      const line = `[${t.sourceUrl}] ${t.body ?? ''}`;
      used += line.length;
      if (used > cap) {
        lines.push(`(transcript truncated at ${cap} chars)`);
        break;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Business-tracker bundle (Tier B weekly narrative): ABC license events plus
// business-relevant chino-legistar planning items for one ISO week. The shape
// extends MeetingBundle so the existing Gate 2 judge path works unchanged —
// all week items ride in agendaItems for the judge's render; the generator
// gets its own renderBusinessBundleForPrompt with honest section labels.
// ---------------------------------------------------------------------------

export interface BusinessBundle extends MeetingBundle {
  isoWeek: string;
  licenseEvents: BundleItem[];
  planningItems: BundleItem[];
}

// ISO week of a stored occurred_at, computed on UTC calendar fields (a
// date-only string parses as UTC midnight, so it maps to its own week).
// A naive datetime (no zone suffix) would parse as machine-LOCAL time and
// shift items into adjacent weeks depending on the server's timezone, so it
// is anchored to UTC before parsing.
const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export function isoWeekOfOccurredAt(occurredAt: string | null): string | null {
  if (!occurredAt) return null;
  const anchored = NAIVE_DATETIME_RE.test(occurredAt)
    ? `${occurredAt.replace(' ', 'T')}Z`
    : occurredAt;
  const d = new Date(anchored);
  if (Number.isNaN(d.getTime())) return null;
  return isoWeekOf(d);
}

// Planning items that bear on local business activity. Deliberately narrow:
// a miss keeps an item out of one weekly roundup, but a loose match drags
// unrelated council business into the synthesis input.
const BUSINESS_RELEVANCE_RES = [
  /conditional use permit/i,
  /\bzoning\b/i,
  /\bzone change\b/i,
  /\brezon\w*/i,
  /\blicens\w*/i,
  /development agreement/i,
];

export function isBusinessRelevant(title: string | null, body: string | null): boolean {
  const text = `${title ?? ''}\n${body ?? ''}`;
  return BUSINESS_RELEVANCE_RES.some((re) => re.test(text));
}

const BUSINESS_SOURCES = {
  licenses: { key: 'abc-licenses', type: 'license_event' },
  planning: { key: 'chino-legistar', type: 'agenda_item' },
} as const;

function weekItemsFor(db: Db, sourceKey: string, itemType: string, isoWeek: string): BundleItem[] {
  const rows = db.raw
    .prepare(
      `SELECT i.item_type, i.title, i.body, i.source_url, i.meta, i.occurred_at
       FROM items i JOIN documents d ON i.document_id = d.id JOIN sources s ON d.source_id = s.id
       WHERE s.key = ? AND i.item_type = ? ORDER BY i.occurred_at, i.id`
    )
    .all(sourceKey, itemType) as unknown as RawItemRow[];
  return rows.filter((r) => isoWeekOfOccurredAt(r.occurred_at) === isoWeek).map(toBundleItem);
}

export function listBusinessWeeks(
  db: Db
): Array<{ isoWeek: string; counts: { licenseEvents: number; planningItems: number } }> {
  const counts = new Map<string, { licenseEvents: number; planningItems: number }>();
  const bump = (week: string | null, field: 'licenseEvents' | 'planningItems') => {
    if (!week) return;
    const c = counts.get(week) ?? { licenseEvents: 0, planningItems: 0 };
    c[field]++;
    counts.set(week, c);
  };
  const all = (k: { key: string; type: string }) =>
    db.raw
      .prepare(
        `SELECT i.item_type, i.title, i.body, i.source_url, i.meta, i.occurred_at
         FROM items i JOIN documents d ON i.document_id = d.id JOIN sources s ON d.source_id = s.id
         WHERE s.key = ? AND i.item_type = ? ORDER BY i.id`
      )
      .all(k.key, k.type) as unknown as RawItemRow[];
  for (const r of all(BUSINESS_SOURCES.licenses)) bump(isoWeekOfOccurredAt(r.occurred_at), 'licenseEvents');
  for (const r of all(BUSINESS_SOURCES.planning)) {
    if (isBusinessRelevant(r.title, r.body)) bump(isoWeekOfOccurredAt(r.occurred_at), 'planningItems');
  }
  return [...counts.entries()]
    .map(([isoWeek, c]) => ({ isoWeek, counts: c }))
    .sort((a, b) => (a.isoWeek < b.isoWeek ? 1 : -1));
}

// Natural-language rendering of a license_event's meta record. This text
// becomes the item's BODY, which is (a) the generator's source detail,
// (b) the judge's only view of the record (renderBundleForPrompt shows
// title/source/body, never meta), and (c) grounding for the name/number
// gates via inputCorpus — all three must see the same facts, so the text is
// built once here. URL-valued meta (attempted_detail_url) is deliberately
// excluded: the only URLs in any prompt must be the citable ones.
export function licenseEventDetail(meta: Record<string, unknown>): string | null {
  const s = (k: string): string | null => {
    const v = meta[k];
    if (typeof v === 'number') return String(v);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const parts: string[] = [];
  const licenseNo = s('license_no');
  const licenseType = s('license_type');
  if (licenseNo) parts.push(`License ${licenseNo}${licenseType ? ` (Type ${licenseType})` : ''}.`);
  const status = s('status');
  if (status) {
    const reportKind = meta.report_type === 'new_applications' ? 'new-applications' : 'status-change';
    const reportDate = s('report_date');
    parts.push(
      `Status: ${status}, per the California ABC ${reportKind} report${reportDate ? ` dated ${reportDate}` : ''}.`
    );
  }
  const primary = s('primary_name');
  if (primary) parts.push(`Licensee: ${primary}.`);
  const dba = s('dba');
  if (dba) parts.push(`Doing business as ${dba}.`);
  const premises = s('premises_address');
  if (premises) parts.push(`Premises: ${premises}.`);
  const issued = s('original_issue_date');
  if (issued) parts.push(`Original issue date ${issued}.`);
  const expiry = s('expiry_date');
  if (expiry) parts.push(`Expiration date ${expiry}.`);
  const transfer = s('transfer_from_to');
  if (transfer) parts.push(`Transfer from/to: ${transfer}.`);
  return parts.length ? parts.join(' ') : null;
}

export function assembleBusinessBundle(db: Db, isoWeek: string): BusinessBundle | null {
  const licenseEvents = weekItemsFor(db, BUSINESS_SOURCES.licenses.key, BUSINESS_SOURCES.licenses.type, isoWeek)
    .map((it) => (it.body ? it : { ...it, body: licenseEventDetail(it.meta) }));
  const planningItems = weekItemsFor(db, BUSINESS_SOURCES.planning.key, BUSINESS_SOURCES.planning.type, isoWeek)
    .filter((it) => isBusinessRelevant(it.title, it.body));
  if (licenseEvents.length === 0 && planningItems.length === 0) return null;

  const allItems = [...licenseEvents, ...planningItems];
  const allowedUrls = [...new Set(allItems.map((i) => i.sourceUrl))];
  const bodyName = 'Chino Valley business activity';
  const corpusParts: string[] = [bodyName, isoWeek];
  for (const it of allItems) {
    if (it.title) corpusParts.push(it.title);
    if (it.body) corpusParts.push(it.body);
    for (const v of Object.values(it.meta)) {
      if (typeof v === 'string' || typeof v === 'number') corpusParts.push(String(v));
    }
  }
  return {
    targetKey: `business:${isoWeek}`,
    sourceKey: 'business-tracker',
    bodyName,
    meetingDate: isoWeek, // week label rides in the MeetingBundle date slot
    agendaItems: allItems,
    votes: [],
    transcriptSegments: [],
    allowedUrls,
    inputCorpus: corpusParts.join('\n'),
    isoWeek,
    licenseEvents,
    planningItems,
  };
}

// Generator payload for the weekly narrative. Record facts arrive via each
// item's body (license events carry the synthesized licenseEventDetail text);
// raw meta is never rendered — its snake_case keys are not in inputCorpus and
// the generator echoing one as prose ("License No.") trips the name gate —
// and the only URLs the generator ever sees are the citable ones.
export function renderBusinessBundleForPrompt(b: BusinessBundle): string {
  const lines: string[] = [];
  lines.push(`# Chino Valley business activity — ISO week ${b.isoWeek}`);
  lines.push(
    '',
    '## Citable source URLs (the ONLY URLs you may link; cite as inline markdown links, never shorthand):'
  );
  b.allowedUrls.forEach((u) => lines.push(`- ${u}`));

  const pushItem = (it: BundleItem) => {
    lines.push(`- ${it.title ?? '(untitled)'}`);
    lines.push(`  source: ${it.sourceUrl}`);
    if (it.body) lines.push(`  detail: ${it.body.slice(0, 500)}`);
  };
  if (b.licenseEvents.length) {
    lines.push('', '## ABC license events (verbatim record fields):');
    b.licenseEvents.forEach(pushItem);
  }
  if (b.planningItems.length) {
    lines.push('', '## Business-relevant planning/agenda items (verbatim):');
    b.planningItems.forEach(pushItem);
  }
  return lines.join('\n');
}
