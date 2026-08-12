// City of Chino YouTube captions (channel "chinotv3", the city's official
// video channel, found via cityofchino.org/167/Stay-Connected on 2026-08-12).
// Posts full council meetings ("City of Chino Council Meeting - July 21,
// 2026") and study sessions, alongside promo content (Choose Chino, Mayor's
// Message) that this scraper must filter out.
//
// This completes the Chino recap bundle: chino-legistar supplies agenda items
// + recorded votes; this supplies the timestamped transcript.
import type { ScraperDef } from './types.ts';
import {
  ingestVideoCaptions,
  listRecentUploads,
  parseDurationSeconds,
  parseTitleDate,
} from './youtube-shared.ts';

const CHANNEL_URL = 'https://www.youtube.com/user/chinotv3';
const PLAYLIST_LIMIT = 15;
const TOP_N = 2; // ingest the 2 most recent meetings (council or study session)

const scraper: ScraperDef = {
  key: 'chino-youtube-captions',
  name: 'City of Chino YouTube captions (chinotv3)',
  baseUrl: CHANNEL_URL,
  method: 'captions',
  async run(ctx) {
    const entries = await listRecentUploads(CHANNEL_URL, PLAYLIST_LIMIT);
    ctx.note(
      `yt-dlp --flat-playlist listed ${entries.length} recent upload(s) from chinotv3. The channel mixes ` +
        'meeting recordings with promo content (Choose Chino, Mayor\'s Message, Experience Chino) — filtered ' +
        'to /council meeting|study session/i with a parseable "<Month> <D>, <YYYY>" title date.'
    );

    const candidates = entries
      .map((e) => ({ ...e, date: parseTitleDate(e.title), seconds: parseDurationSeconds(e.durationStr) }))
      .filter(
        (e): e is (typeof e) & { date: string } =>
          /council meeting|study session/i.test(e.title) && e.date !== null
      )
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.seconds - a.seconds));

    if (candidates.length === 0) {
      ctx.note(
        `No upload in the most recent ${entries.length} matched the meeting filter. Titles seen: ` +
          entries.map((e) => `"${e.title}"`).join('; ')
      );
      return;
    }

    const chosen = candidates.slice(0, TOP_N);
    ctx.note(
      `Ingesting ${chosen.length} meeting video(s): ` +
        chosen.map((c) => `"${c.title}" (${c.id}, ${c.durationStr}, ${c.date})`).join('; ')
    );

    for (const video of chosen) {
      await ingestVideoCaptions(ctx, video);
    }

    ctx.note(
      'Meeting dates parsed from titles align with chino-legistar meeting dates (e.g. the 2026-07-21 council ' +
        'meeting exists in both), which is what lets the recap bundle join transcript to agenda+votes by date. ' +
        'Auto-captions only (no manual track) — same proper-name garbling risk as the CVUSD channel; Gate 1c applies.'
    );
  },
};

export default scraper;
