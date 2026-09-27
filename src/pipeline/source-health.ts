// Is every source still feeding the pipeline? Read by the 08:00 watchdog
// (brief-health.ts) and at build time by the site's /health page, which is why
// this module imports nothing but pure data: the site build loads it directly.
import { QUIET_IS_HEALTHY } from "../scrapers/quiet-policy.ts";

// Structural, so the pipeline's Db and the site's bare node:sqlite handle both fit.
export interface RunsDb {
	raw: { prepare(sql: string): { all(...params: string[]): unknown[] } };
}

type ScrapeRunSummary = {
	status: "running" | "success" | "failure";
	items_count: number;
	started_at: string;
	finished_at: string | null;
	error_message: string | null;
};

export interface SourceDegradedResult {
	sourceKey: string;
	degraded: boolean;
	reason: string;
	runs: ScrapeRunSummary[];
}

// Sources whose timer fails by design while the droplet's IP is blocked, and
// which succeed only when a person replays a recording from their own machine
// (src/replay.ts, the meeting-recaps skill's weekly pull). Their failing runs
// are expected; going this long without ANY success is not, because it means
// the pull was missed.
export const MANUAL_PULL_GRACE_DAYS: Record<string, number> = {
	"chinohills-swagit": 8,
	"chino-youtube-captions": 8,
	"youtube-captions": 8,
};

// run-one.ts records a ToS-held source as a failed run with this prefix.
const HELD_PREFIX = "Scraper held:";

// Any source can keep "succeeding" while the site it reads silently drifts out
// from under the scraper, extracting 0 items run after run — invisible to a
// check that only looks at the latest run's status. This looks at the last 3
// recorded runs per source and flags degraded only on two unambiguous patterns:
// 3 straight failures, or 3 straight successes with 0 items. Anything mixed is
// left alone — a single bad run, or a success/failure mix, isn't proof of
// drift. Fewer than 3 recorded runs is insufficient evidence either way, so it
// is never reported as degraded.
//
// The 3-failures rule applies to every source, with two exceptions: a source
// held for ToS review (a decision waiting on a person, some held by design,
// not a breakage), and a manual-pull source still inside its grace window.
// The 3-zero-items rule needs to know whether quiet is this source's normal
// state, which QUIET_IS_HEALTHY declares per source and a test holds to the
// registry.
//
// This watches EVERY source, not just the six press outlets it originally
// covered. chinohills-swagit ingested nothing for six days and no watchdog
// could see it, because a transcript source was not in anything's list.
export function checkDegradedSources(
	db: RunsDb,
	sourceKeys: readonly string[] = Object.keys(QUIET_IS_HEALTHY),
	now: Date = new Date(),
): SourceDegradedResult[] {
	const lastRuns = db.raw.prepare(
		`SELECT status, items_count, started_at, finished_at, error_message
		 FROM scrape_runs
		 WHERE source_key = ?
		 ORDER BY id DESC
		 LIMIT 3`,
	);
	const lastSuccess = db.raw.prepare(
		`SELECT max(started_at) AS at FROM scrape_runs
		 WHERE source_key = ? AND status = 'success'`,
	);
	return sourceKeys.map((sourceKey) => {
		const runs = lastRuns.all(sourceKey) as ScrapeRunSummary[];

		if (runs[0]?.error_message?.startsWith(HELD_PREFIX)) {
			return {
				sourceKey,
				degraded: false,
				reason: `held for ToS review: ${runs[0].error_message}`,
				runs,
			};
		}

		if (runs.length < 3) {
			return {
				sourceKey,
				degraded: false,
				reason: `only ${runs.length} run(s) recorded; insufficient evidence`,
				runs,
			};
		}

		if (runs.every((r) => r.status === "failure")) {
			const graceDays = MANUAL_PULL_GRACE_DAYS[sourceKey];
			if (graceDays !== undefined) {
				const [row] = lastSuccess.all(sourceKey) as Array<{
					at: string | null;
				}>;
				const ageDays = row?.at
					? (now.getTime() - Date.parse(row.at)) / 86_400_000
					: Number.POSITIVE_INFINITY;
				return ageDays <= graceDays
					? {
							sourceKey,
							degraded: false,
							reason: `timer runs fail by design (blocked IP); last manual pull ${row?.at} is within ${graceDays} days`,
							runs,
						}
					: {
							sourceKey,
							degraded: true,
							reason: `no successful run in ${graceDays} days: the manual transcript pull is overdue (meeting-recaps skill)`,
							runs,
						};
			}
			return {
				sourceKey,
				degraded: true,
				reason: "last 3 runs all failed",
				runs,
			};
		}

		if (runs.every((r) => r.status === "success" && r.items_count === 0)) {
			const quietIsHealthy = QUIET_IS_HEALTHY[sourceKey] ?? null;
			return quietIsHealthy
				? {
						sourceKey,
						degraded: false,
						reason: `last 3 runs all succeeded with 0 items; expected here — ${quietIsHealthy}`,
						runs,
					}
				: {
						sourceKey,
						degraded: true,
						reason: "last 3 runs all succeeded but extracted 0 items",
						runs,
					};
		}
		return {
			sourceKey,
			degraded: false,
			reason: "runs are healthy or mixed",
			runs,
		};
	});
}
