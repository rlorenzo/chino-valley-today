// Post type 4: news digest. ONE post per ISO week: headline + link (+ short
// teaser) for news_release items from the last 14 days across
// chino-news-rss and chinohills-news-rss ONLY. sbsheriff-news is excluded
// entirely, including its coroner items — EDITORIAL.md Tier C: never
// auto-publish content naming private individuals, and a digest of death
// notices is not Tier A material regardless of how the source stores them.
import type { Db } from "../db/index.ts";
import type { NewPost } from "../pipeline/posts.ts";
import { queryItems } from "./queries.ts";
import {
	dedupeByKey,
	isoWeekForNow,
	mdEscape,
	mdLink,
	truncateTeaser,
	withinLastDays,
} from "./util.ts";

interface GenResult {
	posts: NewPost[];
	notes: string[];
}

const WINDOW_DAYS = 14;
const CITY_LABEL: Record<string, string> = {
	"chino-news-rss": "Chino",
	"chinohills-news-rss": "Chino Hills",
};

export function generateNewsDigest(db: Db, now: Date): GenResult {
	const items = queryItems(db, {
		sourceKeys: ["chino-news-rss", "chinohills-news-rss"],
		itemTypes: ["news_release"],
	});
	const notes: string[] = [];
	const posts: NewPost[] = [];

	const inWindow = items.filter(
		(r) => withinLastDays(r.occurred_at, now, WINDOW_DAYS) && r.title?.trim(),
	);
	const deduped = dedupeByKey(inWindow, (r) => r.source_url);
	const sorted = [...deduped].sort((a, b) =>
		(b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""),
	);
	const dupesRemoved = inWindow.length - deduped.length;

	if (sorted.length === 0) {
		notes.push(
			`0 news_release item(s) in the last ${WINDOW_DAYS} days from chino-news-rss/chinohills-news-rss (${items.length} total in DB) — skipped. sbsheriff-news is always excluded regardless (EDITORIAL.md Tier C).`,
		);
		return { posts, notes };
	}

	const week = isoWeekForNow(now);
	const lines = sorted.map((row) => {
		const label = CITY_LABEL[row.source_key] ?? row.source_key;
		const dateLabel = (row.occurred_at ?? "").slice(0, 10);
		const head = `- ${mdLink((row.title ?? "").trim(), row.source_url)} — ${dateLabel} (${label})`;
		if (row.body && row.body.trim()) {
			return `${head}\n  ${mdEscape(truncateTeaser(row.body))}`;
		}
		return head;
	});

	posts.push({
		slug: `${week}-news-digest`,
		postType: "news_digest",
		tier: "A",
		title: `Chino Valley News Digest — ${week}`,
		bodyMd: lines.join("\n\n"),
		sources: sorted.map((r) => r.source_url),
	});

	notes.push(
		`${sorted.length} news_release item(s) in the last ${WINDOW_DAYS} days` +
			(dupesRemoved > 0
				? ` (${dupesRemoved} duplicate row(s) deduped by source_url)`
				: "") +
			` -> 1 news_digest post (${week}). sbsheriff-news coroner items excluded entirely per EDITORIAL.md Tier C.`,
	);
	return { posts, notes };
}
