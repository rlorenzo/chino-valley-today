// Watchdog for the morning brief, run by cvt-brief-watch.timer at 08:00
// Pacific — two hours after the brief was due.
//
// A static site cannot expire its own /health page: if the mornings stopped,
// a keyword monitor would keep reading the last build's "pipeline=fresh"
// forever. This closes that loop for the no-rebuild case: when today's brief
// has not published or is not serving HTTP 200, the LIVE health file is rewritten
// to "pipeline=stale", and the external keyword monitor (alerting on the ABSENCE of
// "pipeline=fresh") fires. The next successful brief run rebuilds the whole
// site, which restores the fresh stamp — nothing here ever un-flips.
//
// The unit fails (exit 1) whenever the brief is missing or HTTP check fails,
// flip or no flip, so `systemctl --failed` shows the real problem alongside the alert.
//
// Usage: node src/pipeline/brief-health.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Db, openDb } from "../db/index.ts";
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

export function checkBriefDatabase(
	db: Db,
	now: Date,
): { ok: boolean; status?: string; slug: string } {
	const slug = expectedBriefSlug(now);
	const row = db.raw
		.prepare("SELECT status FROM posts WHERE slug = ?")
		.get(slug) as { status: string } | undefined;

	if (row?.status === "published") {
		return { ok: true, status: "published", slug };
	}
	return { ok: false, status: row ? row.status : "absent", slug };
}

export async function checkBriefHttp(
	dateStr: string,
	opts: { baseUrl?: string; fetchFn?: typeof fetch } = {},
): Promise<{ ok: boolean; status?: number; error?: string }> {
	const baseUrl =
		opts.baseUrl ?? process.env.CVT_BASE_URL ?? "http://127.0.0.1";
	const url = `${baseUrl.replace(/\/+$/, "")}/brief/${dateStr}/`;
	const fetcher = opts.fetchFn ?? fetch;

	try {
		const res = await fetcher(url, {
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				error: `HTTP ${res.status} fetching ${url}`,
			};
		}
		const text = await res.text();
		if (
			!text.includes(dateStr) &&
			!text.includes("Daily Brief") &&
			!text.includes("daily-brief")
		) {
			return {
				ok: false,
				status: res.status,
				error: `response from ${url} missing brief content markers`,
			};
		}
		return { ok: true, status: res.status };
	} catch (err) {
		return {
			ok: false,
			error: `failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export async function verifyBriefHealth(
	db: Db,
	now: Date,
	opts: { baseUrl?: string; fetchFn?: typeof fetch } = {},
): Promise<{
	healthy: boolean;
	dbOk: boolean;
	httpOk: boolean;
	error?: string;
}> {
	const laDate = laDateOf(now.toISOString());
	if (!laDate) {
		return {
			healthy: false,
			dbOk: false,
			httpOk: false,
			error: "could not compute LA date for brief verification",
		};
	}
	const dbCheck = checkBriefDatabase(db, now);
	const httpCheck = await checkBriefHttp(laDate, opts);

	const healthy = dbCheck.ok && httpCheck.ok;
	const errors: string[] = [];
	if (!dbCheck.ok) {
		errors.push(`database check failed (${dbCheck.slug} is ${dbCheck.status})`);
	}
	if (!httpCheck.ok) {
		errors.push(
			`http delivery check failed (${httpCheck.error ?? "HTTP check failed"})`,
		);
	}

	return {
		healthy,
		dbOk: dbCheck.ok,
		httpOk: httpCheck.ok,
		error: errors.length > 0 ? errors.join("; ") : undefined,
	};
}

async function main(): Promise<void> {
	const now = new Date();
	const slug = expectedBriefSlug(now);
	const db = openDb();
	const webRoot = process.env.CVT_WEB_ROOT ?? "/var/www/chinovalley.today";
	const healthPath = join(webRoot, "current", "health");

	const result = await verifyBriefHealth(db, now, {
		baseUrl: process.env.CVT_BASE_URL ?? "http://127.0.0.1",
	});

	if (result.healthy) {
		console.log(
			`ok: ${slug} is published in database and verified via HTTP 200; health page left as built.`,
		);
		return;
	}

	console.error(
		`MISSING/UNHEALTHY: ${result.error} — marking ${healthPath} ${STALE}`,
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

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
