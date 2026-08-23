// Article-path shapes for the two secondary-press outlets discovered by URL
// rather than by feed. They live apart from the scrapers because two layers
// need the same definition: the scraper, which decides what to fetch and
// re-checks where a redirect landed, and the daily brief's renderer, the last
// gate before a link reaches a reader. One definition so the two cannot drift.
//
// Deliberately free of scraper dependencies — the pipeline imports this and
// should not pull cheerio or an XML parser along with it.

/**
 * Blox CMS permalinks: /<section>/article_<uuid>.html. Only the editorial
 * sections we ingest; legal_notices and obituaries are excluded on purpose.
 */
export const CHAMPION_ARTICLE_PATH_RE =
	/^\/(?:community_news|news|business|sports_and_recreation)\/article_([a-f0-9-]+)\.html$/;

/** WordPress permalinks: /YYYY/MM/DD/slug/. */
export const DAILY_BULLETIN_ARTICLE_PATH_RE =
	/^\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\/?$/;
