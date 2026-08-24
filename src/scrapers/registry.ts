// Module paths are relative to src/ (run-one.ts / run-poc.ts import from there).
// A missing file is reported as "not implemented" by the runner, not a crash.
export const SCRAPERS: Record<string, string> = {
	"chino-legistar": "./scrapers/chino-legistar.ts",
	"chino-agendacenter": "./scrapers/chino-agendacenter.ts",
	"chino-news-rss": "./scrapers/chino-news-rss.ts",
	"chinohills-agendas": "./scrapers/chinohills-agendas.ts",
	"chinohills-news-rss": "./scrapers/chinohills-news-rss.ts",
	"chinohills-swagit": "./scrapers/chinohills-swagit.ts",
	"cvusd-board": "./scrapers/cvusd-board.ts",
	"youtube-captions": "./scrapers/youtube-captions.ts",
	"chino-youtube-captions": "./scrapers/chino-youtube.ts",
	"nws-alerts": "./scrapers/nws-alerts.ts",
	"abc-licenses": "./scrapers/abc-licenses.ts",
	"sbsheriff-news": "./scrapers/sbsheriff-news.ts",
	"sbsheriff-nixle-mail": "./scrapers/sbsheriff-nixle-mail.ts",
	// Phase 4 Task 4.1 (daily-brief redirection, 2026-08-17)
	"nws-forecast": "./scrapers/nws-forecast.ts",
	"sbcfire-news": "./scrapers/sbcfire-news.ts",
	"cvfd-news": "./scrapers/cvfd-news.ts",
	"sbclib-events": "./scrapers/sbclib-events.ts",
	"sbparks-events": "./scrapers/sbparks-events.ts",
	"cbwcd-events": "./scrapers/cbwcd-events.ts",
	"yanksair-events": "./scrapers/yanksair-events.ts",
	// Phase 4 Task 4.2 (headlines-elsewhere press ingestion, 2026-08-18)
	"champion-news": "./scrapers/champion-news.ts",
	"dailybulletin-news": "./scrapers/dailybulletin-news.ts",
	// Press expansion (student papers + NBC4 keyword-filtered, 2026-08-19)
	"quest-news": "./scrapers/quest-news.ts",
	"bulldogtimes-news": "./scrapers/bulldogtimes-news.ts",
	"breeze-news": "./scrapers/breeze-news.ts",
	"nbc4-news": "./scrapers/nbc4-news.ts",
	// Phase 4 Task 4.8 (high school sports, 2026-08-23). Three schools, one
	// Home Campus core; Chino Hills has no Home Campus site and is separate.
	"chinohigh-sports": "./scrapers/chinohigh-sports.ts",
	"ayala-sports": "./scrapers/ayala-sports.ts",
	"donlugo-sports": "./scrapers/donlugo-sports.ts",
	// Chino Hills has no Home Campus site; CIF-SS's widget serves it instead.
	"chinohills-sports": "./scrapers/chinohills-sports.ts",
	// Minutes are ingested from a hand-dropped directory, not fetched: the
	// Laserfiche host that publishes them disallows automated retrieval.
	"chinohills-minutes": "./scrapers/chinohills-minutes.ts",
};
