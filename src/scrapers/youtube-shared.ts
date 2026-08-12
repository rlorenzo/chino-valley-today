// Shared yt-dlp + YouTube auto-caption machinery for channel caption
// scrapers (CVUSD board, City of Chino). Fetching goes through yt-dlp
// (child_process), NOT politeFetch — yt-dlp manages its own YouTube-specific
// fetching/throttling. The VTT is archived by hand via saveRaw +
// ctx.db.insertDocument (the approved pattern for caption sources).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScraperContext } from './types.ts';
import { readRaw, saveRaw } from '../store.ts';

const execFileAsync = promisify(execFile);

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

// Upload titles are free text ("... July 21, 2026"); extract the date rather
// than trusting playlist position or upload_date (the latter is "NA" in
// --flat-playlist mode, and playlist order was observed NOT to be strictly
// chronological on the CVUSD channel).
export function parseTitleDate(title: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})/.exec(title);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

export function parseDurationSeconds(s: string): number {
  const parts = s.split(':').map(Number);
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export interface PlaylistEntry {
  id: string;
  title: string;
  durationStr: string;
}

export async function listRecentUploads(channelUrl: string, limit: number): Promise<PlaylistEntry[]> {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    ['--flat-playlist', '--print', '%(id)s|%(title)s|%(duration_string)s', '--playlist-end', String(limit), channelUrl],
    { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 }
  );
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, title, durationStr] = line.split('|');
      return { id, title, durationStr };
    });
}

function decodeVttEntities(s: string): string {
  return s
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

export interface RawCue {
  start: number;
  end: number;
  text: string;
}

function tsToSeconds(ts: string): number {
  const m = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(ts);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

// YouTube auto-caption VTT uses a rolling two-line display: each cue repeats
// the previous cue's newest line as its first line, then grows a second line
// word-by-word via <NN:NN:NN.NNN><c>...</c> per-word timing tags. Cues
// alternate between "growing" blocks (line1 = previous text, line2 = new
// text being typed in) and near-zero-length "transition" blocks (line1 = the
// text that just finished growing, line2 = blank/whitespace). Taking each
// cue's last non-blank stripped line is NOT enough by itself: a transition
// block's line2 is blank, but line1 (the just-finished text) survives the
// blank-filter and becomes that cue's "last line" too — identical to the
// previous kept cue's text. So every real line is naturally followed by one
// exact duplicate, and an explicit consecutive-equality dedup is required on
// top of the blank-filter (confirmed against a real 42-minute meeting
// transcript, hRO51ueaqb4: 1846 non-blank last-lines collapse to 939 after
// dropping immediate repeats — leaving an ordered, non-repeating text stream).
export function parseRawCues(vtt: string): RawCue[] {
  const blocks = vtt.split(/\r?\n\r?\n+/);
  const cues: RawCue[] = [];
  let lastText = '';
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const tsLine = lines.find((l) => l.includes('-->'));
    if (!tsLine) continue;
    const [startRaw, endRaw] = tsLine.split('-->').map((s) => s.trim().split(' ')[0]);
    const contentLines = lines.slice(lines.indexOf(tsLine) + 1);
    const stripped = contentLines.map((l) => decodeVttEntities(l.replace(/<[^>]*>/g, '')).trim());
    const nonEmpty = stripped.filter((l) => l.length > 0);
    const text = nonEmpty.at(-1) ?? '';
    if (!text || text === lastText) continue;
    lastText = text;
    cues.push({ start: tsToSeconds(startRaw), end: tsToSeconds(endRaw), text });
  }
  return cues;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

// Merge fine-grained caption lines (~2s / ~7 words each) into readable
// transcript_segment chunks bounded by time span and character count.
export function mergeCuesIntoSegments(
  cues: RawCue[],
  opts: { maxSpanSec?: number; maxChars?: number } = {}
): Segment[] {
  const maxSpanSec = opts.maxSpanSec ?? 20;
  const maxChars = opts.maxChars ?? 500;
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const c of cues) {
    if (!cur) {
      cur = { start: c.start, end: c.end, text: c.text };
      continue;
    }
    const span = c.end - cur.start;
    if (span > maxSpanSec || cur.text.length + c.text.length > maxChars) {
      segs.push(cur);
      cur = { start: c.start, end: c.end, text: c.text };
    } else {
      cur.end = c.end;
      cur.text += ' ' + c.text;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

export async function downloadAutoCaptions(videoId: string, watchUrl: string): Promise<Buffer> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'yt-captions-'));
  try {
    await execFileAsync(
      'yt-dlp',
      ['--skip-download', '--write-auto-sub', '--sub-format', 'vtt', '--sub-langs', 'en', '-o', join(tmpDir, '%(id)s'), watchUrl],
      { maxBuffer: 20 * 1024 * 1024, timeout: 120_000 }
    );
    return readFileSync(join(tmpDir, `${videoId}.en.vtt`));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Full per-video ingest: idempotent (re-runs re-parse the archived VTT via
// ctx.db.latestDocument instead of re-hitting YouTube), archives the VTT,
// inserts transcript_segment items with timestamped watch URLs.
export async function ingestVideoCaptions(
  ctx: ScraperContext,
  video: { id: string; title: string; date: string },
  opts: { maxSegments?: number } = {}
): Promise<{ segments: number; fromCache: boolean }> {
  const maxSegments = opts.maxSegments ?? 1000;
  const watchUrl = `https://www.youtube.com/watch?v=${video.id}`;

  const prevDoc = ctx.db.latestDocument(watchUrl);
  let vttBytes: Buffer;
  let documentId: number;
  if (prevDoc) {
    ctx.note(
      `Captions document already exists for ${watchUrl} (document id ${prevDoc.id}) — skipping the yt-dlp ` +
        'caption download and re-parsing the already-archived VTT (avoids re-hitting YouTube on repeat runs).'
    );
    vttBytes = readRaw(prevDoc.raw_path);
    documentId = prevDoc.id;
    ctx.db.touchDocument(prevDoc.id);
    ctx.counts.documentsFetched++;
  } else {
    vttBytes = await downloadAutoCaptions(video.id, watchUrl);
    const { hash, rawPath } = saveRaw(vttBytes, 'vtt');
    const ins = ctx.db.insertDocument({
      source_id: ctx.sourceId,
      url: watchUrl,
      doc_type: 'captions',
      title: video.title,
      meeting_date: video.date,
      content_hash: hash,
      raw_path: rawPath,
    });
    documentId = ins.id;
    ctx.counts.documentsFetched++;
    if (ins.isNew) ctx.counts.documentsNew++;
    ctx.note(
      `Downloaded auto-captions for "${video.title}" via yt-dlp (--skip-download --write-auto-sub), archived ` +
        'via saveRaw() + ctx.db.insertDocument() directly — bypasses politeFetch since yt-dlp did its own fetching.'
    );
  }

  const rawCues = parseRawCues(vttBytes.toString('utf8'));
  const segments = mergeCuesIntoSegments(rawCues);
  let toInsert = segments;
  if (segments.length > maxSegments) {
    toInsert = segments.slice(0, maxSegments);
    ctx.note(`Truncated to ${maxSegments} segments (video ${video.id} produced ${segments.length}).`);
  }
  toInsert.forEach((seg, i) => {
    ctx.insertItem({
      document_id: documentId,
      source_url: `${watchUrl}&t=${Math.floor(seg.start)}s`,
      item_type: 'transcript_segment',
      external_id: `${video.id}-${i}`,
      body: seg.text,
      occurred_at: video.date,
      meta: { videoId: video.id, startSeconds: seg.start, endSeconds: seg.end },
    });
  });
  ctx.note(
    `VTT for ${video.id}: ${rawCues.length} de-duplicated cues -> ${segments.length} segment(s), inserted ${toInsert.length}.`
  );
  return { segments: toInsert.length, fromCache: !!prevDoc };
}
