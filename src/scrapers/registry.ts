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
};
