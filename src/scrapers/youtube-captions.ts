// Task 0.6 — CVUSD Board of Education YouTube captions.
//
// Channel: "Chino Valley Unified School Dist Board Videos"
// (UCWKinB4PTb_uskobmwBF8pw) — confirmed both by yt-dlp channel metadata and
// by cross-checking against the youtube.com/watch links embedded in the
// cvusd-board.ts listing pages (same video IDs appear in both places).
//
// The yt-dlp + VTT machinery lives in youtube-shared.ts (also used by
// chino-youtube.ts); this file keeps only CVUSD-specific selection logic
// and findings.
import type { ScraperDef } from './types.ts';
import {
  ingestVideoCaptions,
  listRecentUploads,
  parseDurationSeconds,
  parseTitleDate,
} from './youtube-shared.ts';

const CHANNEL_URL = 'https://www.youtube.com/channel/UCWKinB4PTb_uskobmwBF8pw';
const PLAYLIST_LIMIT = 15;

const scraper: ScraperDef = {
  key: 'youtube-captions',
  name: 'CVUSD Board of Education YouTube captions',
  baseUrl: CHANNEL_URL,
  method: 'captions',
  async run(ctx) {
    const entries = await listRecentUploads(CHANNEL_URL, PLAYLIST_LIMIT);
    ctx.note(
      `yt-dlp --flat-playlist listed ${entries.length} recent upload(s) from the CVUSD Board Videos channel ` +
        '(UCWKinB4PTb_uskobmwBF8pw). Titles are free text ("CVUSD Meeting of the Board of Education <Month> ' +
        '<Day>, <Year>"); playlist order is NOT strictly chronological in this channel\'s default tab (a ' +
        '46-second April 2026 stub outranked a full-length January 2026 meeting in one listing), so the target ' +
        'video is selected by date parsed out of the title, not by list position.'
    );

    const candidates = entries
      .map((e) => ({ ...e, date: parseTitleDate(e.title), seconds: parseDurationSeconds(e.durationStr) }))
      .filter((e): e is (typeof e) & { date: string } => /board|meeting/i.test(e.title) && e.date !== null);

    if (candidates.length === 0) {
      ctx.note(
        `No upload in the most recent ${entries.length} matched /board|meeting/i with a parseable title date. ` +
          `Titles seen: ${entries.map((e) => `"${e.title}"`).join('; ')}`
      );
      return;
    }

    candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.seconds - a.seconds));
    const chosen = candidates[0];
    ctx.note(
      `Chosen video: "${chosen.title}" (${chosen.id}, ${chosen.durationStr}, meeting date ${chosen.date}). The ` +
        'channel posts a short companion "closed session" stub alongside most full meetings (same date, ~1 ' +
        'minute long, e.g. jDPJp9R3mh0 alongside this one); picking max(title date) then max(duration) among ' +
        'same-date candidates reliably selects the substantive open-session recording over the stub. Cross-' +
        "checked against cvusd-board.ts's listing-page parse: this exact video URL is the one linked from the " +
        `district's own ${chosen.date} meeting row.`
    );

    await ingestVideoCaptions(ctx, chosen);

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
        "plus-special cadence seen in cvusd-board.ts's listing pages, with uploads going back to at least 2020."
    );
  },
};

export default scraper;
