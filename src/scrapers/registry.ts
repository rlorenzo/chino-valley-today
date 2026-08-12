// Module paths are relative to src/ (run-one.ts / run-poc.ts import from there).
// A missing file is reported as "not implemented" by the runner, not a crash.
export const SCRAPERS: Record<string, string> = {
  'chino-legistar': './scrapers/chino-legistar.ts',
  'chino-agendacenter': './scrapers/chino-agendacenter.ts',
  'chino-news-rss': './scrapers/chino-news-rss.ts',
  'chinohills-agendas': './scrapers/chinohills-agendas.ts',
  'chinohills-news-rss': './scrapers/chinohills-news-rss.ts',
  'chinohills-swagit': './scrapers/chinohills-swagit.ts',
  'cvusd-board': './scrapers/cvusd-board.ts',
  'youtube-captions': './scrapers/youtube-captions.ts',
  'nws-alerts': './scrapers/nws-alerts.ts',
  'abc-licenses': './scrapers/abc-licenses.ts',
  'sbsheriff-news': './scrapers/sbsheriff-news.ts',
};
