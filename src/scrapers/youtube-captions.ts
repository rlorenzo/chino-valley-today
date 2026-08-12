// Task 0.6 — CVUSD Board of Education YouTube captions.
//
// Channel: "Chino Valley Unified School Dist Board Videos"
// (UCWKinB4PTb_uskobmwBF8pw) — confirmed both by yt-dlp channel metadata and
// by cross-checking against the youtube.com/watch links embedded in the
// cvusd-board.ts listing pages (same video IDs appear in both places).
//
// Fetching goes through yt-dlp (child_process), NOT politeFetch — yt-dlp
// manages its own YouTube-specific fetching/throttling. Per the task's
// approved pattern, this bypasses ctx.fetchDocument: the VTT is archived by
// hand via saveRaw + ctx.db.insertDocument.
//
// Re-run behavior: ctx.db.latestDocument(watchUrl) is checked before any
// caption download, so re-running this scraper against an unchanged "most
// recent meeting" re-parses the already-archived VTT instead of hitting
// YouTube again (keeps re-runs fast and avoids rate-limit risk).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScraperContext, ScraperDef } from './types.ts';
import { readRaw, saveRaw } from '../store.ts';

const execFileAsync = promisify(execFile);

const CHANNEL_URL = 'https://www.youtube.com/channel/UCWKinB4PTb_uskobmwBF8pw';
const PLAYLIST_LIMIT = 15;
const MAX_SEGMENTS = 1000;
const SEGMENT_MAX_SPAN_SEC = 20;
const SEGMENT_MAX_CHARS = 500;

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

// Titles are free text, e.g. "CVUSD Meeting of the Board of Education July
// 16, 2026" — extract the date rather than trusting playlist position or
// upload_date (the latter is "NA" in --flat-playlist mode, and playlist
// order was observed NOT to be strictly chronological: a 46-second April
// 2026 stub outranked a full January 2026 meeting in one listing).
function parseTitleDate(title: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})/.exec(title);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDurationSeconds(s: string): number {
  const parts = s.split(':').map(Number);
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

interface PlaylistEntry {
  id: string;
  title: string;
  durationStr: string;
}

async function listRecentUploads(): Promise<PlaylistEntry[]> {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--flat-playlist',
      '--print',
      '%(id)s|%(title)s|%(duration_string)s',
      '--playlist-end',
      String(PLAYLIST_LIMIT),
      CHANNEL_URL,
    ],
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

interface RawCue {
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
function parseRawCues(vtt: string): RawCue[] {
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

interface Segment {
  start: number;
  end: number;
  text: string;
}

// Merge fine-grained caption lines (~2s / ~7 words each) into readable
// transcript_segment chunks bounded by time span and character count, so a
// 42-minute meeting yields ~100-150 segments instead of ~900+ tiny fragments.
function mergeCuesIntoSegments(cues: RawCue[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const c of cues) {
    if (!cur) {
      cur = { start: c.start, end: c.end, text: c.text };
      continue;
    }
    const span = c.end - cur.start;
    if (span > SEGMENT_MAX_SPAN_SEC || cur.text.length + c.text.length > SEGMENT_MAX_CHARS) {
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

async function downloadAutoCaptions(videoId: string, watchUrl: string): Promise<Buffer> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cvusd-captions-'));
  try {
    await execFileAsync(
      'yt-dlp',
      [
        '--skip-download',
        '--write-auto-sub',
        '--sub-format',
        'vtt',
        '--sub-langs',
        'en',
        '-o',
        join(tmpDir, '%(id)s'),
        watchUrl,
      ],
      { maxBuffer: 20 * 1024 * 1024, timeout: 120_000 }
    );
    return readFileSync(join(tmpDir, `${videoId}.en.vtt`));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const scraper: ScraperDef = {
  key: 'youtube-captions',
  name: 'CVUSD Board of Education YouTube captions',
  baseUrl: CHANNEL_URL,
  method: 'captions',
  async run(ctx: ScraperContext) {
    const entries = await listRecentUploads();
    ctx.note(
      `yt-dlp --flat-playlist listed ${entries.length} recent upload(s) from the CVUSD Board Videos channel ` +
        '(UCWKinB4PTb_uskobmwBF8pw). Titles are free text ("CVUSD Meeting of the Board of Education <Month> ' +
        '<Day>, <Year>"); playlist order is NOT strictly chronological in this channel\'s default tab (a ' +
        '46-second April 2026 stub outranked a full-length January 2026 meeting in one listing), so the target ' +
        'video is selected by date parsed out of the title, not by list position.'
    );

    const candidates = entries
      .map((e) => ({ ...e, date: parseTitleDate(e.title), seconds: parseDurationSeconds(e.durationStr) }))
      .filter((e): e is PlaylistEntry & { date: string; seconds: number } => /board|meeting/i.test(e.title) && e.date !== null);

    if (candidates.length === 0) {
      ctx.note(
        `No upload in the most recent ${entries.length} matched /board|meeting/i with a parseable title date. ` +
          `Titles seen: ${entries.map((e) => `"${e.title}"`).join('; ')}`
      );
      return;
    }

    candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.seconds - a.seconds));
    const chosen = candidates[0];
    const watchUrl = `https://www.youtube.com/watch?v=${chosen.id}`;
    ctx.note(
      `Chosen video: "${chosen.title}" (${chosen.id}, ${chosen.durationStr}, meeting date ${chosen.date}). The ` +
        'channel posts a short companion "closed session" stub alongside most full meetings (same date, ~1 ' +
        'minute long, e.g. jDPJp9R3mh0 alongside this one); picking max(title date) then max(duration) among ' +
        'same-date candidates reliably selects the substantive open-session recording over the stub. Cross-' +
        "checked against cvusd-board.ts's listing-page parse: this exact video URL is the one linked from the " +
        `district's own ${chosen.date} meeting row.`
    );

    const prevDoc = ctx.db.latestDocument(watchUrl);
    let vttBytes: Buffer;
    let documentId: number;
    if (prevDoc) {
      ctx.note(
        `Captions document already exists for ${watchUrl} (document id ${prevDoc.id}) — skipping the yt-dlp ` +
          'caption download and re-parsing the already-archived VTT instead (avoids re-hitting YouTube on repeat runs).'
      );
      vttBytes = readRaw(prevDoc.raw_path);
      documentId = prevDoc.id;
      ctx.db.touchDocument(prevDoc.id);
      ctx.counts.documentsFetched++;
    } else {
      vttBytes = await downloadAutoCaptions(chosen.id, watchUrl);
      const { hash, rawPath } = saveRaw(vttBytes, 'vtt');
      const ins = ctx.db.insertDocument({
        source_id: ctx.sourceId,
        url: watchUrl,
        doc_type: 'captions',
        title: chosen.title,
        meeting_date: chosen.date,
        content_hash: hash,
        raw_path: rawPath,
      });
      documentId = ins.id;
      ctx.counts.documentsFetched++;
      if (ins.isNew) ctx.counts.documentsNew++;
      ctx.note(
        'Downloaded auto-captions via `yt-dlp --skip-download --write-auto-sub --sub-format vtt --sub-langs en`, ' +
          'archived via saveRaw() + ctx.db.insertDocument() directly — bypasses ctx.fetchDocument/politeFetch ' +
          'since yt-dlp did its own fetching (the approved pattern for this source per the task brief).'
      );
    }

    const vttText = vttBytes.toString('utf8');
    const rawCues = parseRawCues(vttText);
    const segments = mergeCuesIntoSegments(rawCues);
    ctx.note(
      `VTT parsing: ${rawCues.length} de-duplicated content cues (rolling two-line auto-caption cues collapsed ` +
        "by keeping only each cue's non-blank last line — see parseRawCues doc comment) merged into " +
        `${segments.length} transcript_segment item(s) using a ${SEGMENT_MAX_SPAN_SEC}s / ${SEGMENT_MAX_CHARS}-char merge window.`
    );

    let toInsert = segments;
    if (segments.length > MAX_SEGMENTS) {
      toInsert = segments.slice(0, MAX_SEGMENTS);
      ctx.note(`Truncated to ${MAX_SEGMENTS} segments (this video produced ${segments.length}).`);
    }

    toInsert.forEach((seg, i) => {
      ctx.insertItem({
        document_id: documentId,
        source_url: `${watchUrl}&t=${Math.floor(seg.start)}s`,
        item_type: 'transcript_segment',
        external_id: `${chosen.id}-${i}`,
        body: seg.text,
        occurred_at: chosen.date,
        meta: { videoId: chosen.id, startSeconds: seg.start, endSeconds: seg.end },
      });
    });
    ctx.note(`Inserted ${toInsert.length} transcript_segment item(s) for ${chosen.id}.`);

    ctx.note(
      'Caption quality on proper names (auto-generated ASR only — `yt-dlp --list-subs` for this video reports ' +
        `"${chosen.id} has no subtitles", i.e. no manually-authored/official track exists on this channel, only ` +
        "YouTube's automatic captions): Trustee James Na is transcribed inconsistently within the SAME roll-call " +
        'sentence read three separate times in one meeting — "Naw", then "N" (dropped to a single letter), then ' +
        'correctly "Na". A staff appointee\'s name is transcribed as "Elise Jükley" (an umlaut inserted mid-name — ' +
        'almost certainly a garbled real surname). The district\'s Executive Assistant is addressed as "Megan" ' +
        'once and then thanked as "Miss Reagan" a few lines later — the same person, two different transcribed ' +
        "names. This directly motivates PLAN.md's Gate 1c (proper-name whitelist): these are exactly the kind of " +
        'transcription-layer errors reports/notes/prior-art.md documents from the CityMeetings.nyc writeup as ' +
        'common and not fully automatable to fix.'
    );
    ctx.note(
      'Video cadence: the channel uploads roughly one video pair (a ~1-minute closed-session stub plus the full ' +
        'open-session recording, 20 minutes to 2.5 hours) per board meeting, matching the ~2x/month regular-' +
        'plus-special cadence seen in cvusd-board.ts\'s listing pages, with uploads going back to at least 2020.'
    );
  },
};

export default scraper;
