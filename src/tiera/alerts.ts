// Post type 2: alert posts. One per ACTIVE NWS alert — "active" means
// meta.ends (the item's own combined ends/expires field, set by
// nws-alerts.ts) parses to an instant strictly after "now". An alert with no
// parseable end time is NOT treated as active — Tier A never guesses.
import type { Db } from "../db/index.ts";
import type { NewPost } from "../pipeline/posts.ts";
import { parseMeta, queryItems } from "./queries.ts";
import {
	alertPostSlug,
	cleanTitle,
	dedupeAlertIssuances,
	localMeetingDate,
	mdEscape,
	mdLink,
} from "./util.ts";

interface GenResult {
	posts: NewPost[];
	notes: string[];
}

export function generateAlerts(db: Db, now: Date): GenResult {
	// One advisory, re-issued as Updates, previously became one post per
	// issuance — three "Weather Alert: Heat Advisory" posts for a single
	// advisory. Keeping the earliest issuance also keeps the slug stable, so
	// a re-issue resolves to the post that already exists.
	const items = dedupeAlertIssuances(queryItems(db, { itemTypes: ["alert"] }));
	const posts: NewPost[] = [];
	const notes: string[] = [];
	let activeCount = 0;

	for (const row of items) {
		const meta = parseMeta(row.meta);
		const ends = typeof meta.ends === "string" ? meta.ends : null;
		if (!ends) continue;
		const endsMs = new Date(ends).getTime();
		if (Number.isNaN(endsMs) || endsMs <= now.getTime()) continue;

		activeCount++;
		const eventName = typeof meta.event === "string" ? meta.event : null;
		const title = cleanTitle(row.title) ?? eventName ?? "NWS Alert";
		const localDate = row.occurred_at
			? localMeetingDate(row.occurred_at)
			: null;
		const dateForSlug = localDate ?? now.toISOString().slice(0, 10);

		const lines: string[] = [];
		if (typeof meta.severity === "string")
			lines.push(`- **Severity:** ${mdEscape(meta.severity)}`);
		if (typeof meta.urgency === "string")
			lines.push(`- **Urgency:** ${mdEscape(meta.urgency)}`);
		if (typeof meta.areaDesc === "string")
			lines.push(`- **Area:** ${mdEscape(meta.areaDesc)}`);
		if (typeof meta.effective === "string")
			lines.push(`- **Effective:** ${mdEscape(meta.effective)}`);
		lines.push(`- **Ends:** ${mdEscape(ends)}`);
		lines.push("");
		if (row.body?.trim()) {
			lines.push(`> ${mdEscape(row.body.replace(/\s+/g, " ").trim())}`, "");
		}
		lines.push(
			mdLink("Official alert data (National Weather Service)", row.source_url),
		);

		posts.push({
			slug: alertPostSlug(dateForSlug, title, row),
			postType: "alert",
			tier: "A",
			title: `Weather Alert: ${title}`,
			bodyMd: lines.join("\n"),
			sources: [row.source_url],
			sourceKeys: [row.source_key],
			itemTypes: [row.item_type],
		});
	}

	notes.push(
		activeCount === 0
			? `0 active alerts (${items.length} alert item(s) in DB total, all already expired as of run time).`
			: `${activeCount} active alert(s) found -> ${posts.length} alert post(s).`,
	);
	return { posts, notes };
}
