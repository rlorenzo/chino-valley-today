// Post type 2: alert posts. One per ACTIVE NWS alert — "active" means
// meta.ends (the item's own combined ends/expires field, set by
// nws-alerts.ts) parses to an instant strictly after "now". An alert with no
// parseable end time is NOT treated as active — Tier A never guesses.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import type { NewPost } from "../pipeline/posts.ts";
import { parseMeta, queryItems } from "./queries.ts";
import {
	cleanTitle,
	localMeetingDate,
	mdEscape,
	mdLink,
	slugify,
} from "./util.ts";

interface GenResult {
	posts: NewPost[];
	notes: string[];
}

export function generateAlerts(db: Db, now: Date): GenResult {
	const items = queryItems(db, { itemTypes: ["alert"] });
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
		const hash = createHash("sha1")
			.update(row.external_id ?? row.source_url)
			.digest("hex")
			.slice(0, 8);

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
		if (row.body && row.body.trim()) {
			lines.push(`> ${mdEscape(row.body.replace(/\s+/g, " ").trim())}`, "");
		}
		lines.push(
			mdLink("Official alert data (National Weather Service)", row.source_url),
		);

		posts.push({
			slug: `${dateForSlug}-${slugify(title)}-alert-${hash}`,
			postType: "alert",
			tier: "A",
			title: `Weather Alert: ${title}`,
			bodyMd: lines.join("\n"),
			sources: [row.source_url],
		});
	}

	notes.push(
		activeCount === 0
			? `0 active alerts (${items.length} alert item(s) in DB total, all already expired as of run time).`
			: `${activeCount} active alert(s) found -> ${posts.length} alert post(s).`,
	);
	return { posts, notes };
}
