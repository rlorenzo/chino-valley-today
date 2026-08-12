// Meeting bundle assembly: gather everything the DB knows about one meeting
// (agenda items, votes, transcript segments) into a synthesis input whose
// every element carries a source_url. The bundle is the ONLY material the
// generator may draw from, and its URL set is the only citable set.
import type { Db } from '../db/index.ts';

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
  lines.push('', '## Citable sources (the ONLY URLs you may link):');
  b.allowedUrls.forEach((u, i) => lines.push(`[S${i + 1}] ${u}`));

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
