// Watchdog for the morning brief, run by cvt-brief-watch.timer at 08:00
// Pacific — two hours after the brief was due.
//
// A static site cannot expire its own /health page: if the mornings stopped,
// a keyword monitor would keep reading the last build's "pipeline=fresh"
// forever. This closes that loop for the no-rebuild case: when today's brief
// has not published, the LIVE health file is rewritten to "pipeline=stale",
// and the external keyword monitor (alerting on the ABSENCE of
// "pipeline=fresh") fires. The next successful brief run rebuilds the whole
// site, which restores the fresh stamp — nothing here ever un-flips.
//
// The unit fails (exit 1) whenever the brief is missing, flip or no flip, so
// `systemctl --failed` shows the real problem alongside the alert.
//
// Usage: node src/pipeline/brief-health.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../db/index.ts";
import { laDateOf } from "./daily-brief.ts";

const FRESH = "pipeline=fresh";
const STALE = "pipeline=stale";

export function expectedBriefSlug(now: Date): string {
	return `${laDateOf(now.toISOString())}-daily-brief`;
}

// Pure flip: the rewritten health text, or null when there is nothing to
// write (the fresh marker is absent — already flipped, or a page whose
// missing marker makes the keyword monitor fire on its own).
export function staleHealthText(health: string): string | null {
	return health.includes(FRESH) ? health.replace(FRESH, STALE) : null;
}

function main(): void {
	const now = new Date();
	const slug = expectedBriefSlug(now);
	const db = openDb();
	const row = db.raw
		.prepare("SELECT status FROM posts WHERE slug = ?")
		.get(slug) as { status: string } | undefined;

	if (row?.status === "published") {
		console.log(`ok: ${slug} is published; health page left as built.`);
		return;
	}

	const webRoot = process.env.CVT_WEB_ROOT ?? "/var/www/chinovalley.today";
	const healthPath = join(webRoot, "current", "health");
	console.error(
		`MISSING: ${slug} is ${row ? row.status : "absent"} — marking ${healthPath} ${STALE}`,
	);
	try {
		const flipped = staleHealthText(readFileSync(healthPath, "utf8"));
		if (flipped === null) {
			console.error(
				`  ${FRESH} not present; nothing to rewrite (monitor fires on its absence either way)`,
			);
		} else {
			writeFileSync(healthPath, flipped);
			console.error(`  wrote ${STALE}`);
		}
	} catch (err) {
		console.error(`  could not rewrite the health file: ${String(err)}`);
	}
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
