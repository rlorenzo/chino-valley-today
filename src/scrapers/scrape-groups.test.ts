import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SCRAPERS } from "./registry.ts";

// A scraper that is registered but belongs to no scrape group is merged and
// inert: nothing on the droplet will ever call it, and no gate notices, because
// every test it has still passes. The same is true one level up, of a group
// that run-group.sh knows about but deploy/systemd/ ships no timer for.
//
// Both have happened. On 2026-08-19 the press scrapers were live with their
// timers uninstalled, and the feature sat dead until someone ran deploy.sh by
// hand. On 2026-08-23 the three Home Campus sports scrapers merged registered
// and working locally, with no group to run them.
//
// The schedule lives in shell, the units live in ini files, and the registry
// lives in TypeScript, so nothing connects them but a person remembering. This
// is that connection.

const repoRoot = join(import.meta.dirname, "..", "..");
const runGroup = readFileSync(join(repoRoot, "scripts/run-group.sh"), "utf8");

/** Every source key named in a `keys=(...)` array, mapped to its group. */
const scheduled = new Map<string, string>();
/** Every group name run-group.sh accepts, in the order it declares them. */
const groups: string[] = [];
/** Keys claimed by more than one group, described for the failure message. */
const duplicates: string[] = [];
// A `<name>)` case arm, then the keys=() array that opens it. The `*)` usage
// arm has no word character to match, so it drops out on its own.
for (const arm of runGroup.matchAll(
	/^[ \t]*(\w[\w-]*)\)\s*\n[ \t]*keys=\(([^)]*)\)/gm,
)) {
	const group = arm[1];
	groups.push(group);
	for (const key of arm[2].split(/\s+/).filter(Boolean)) {
		const prior = scheduled.get(key);
		if (prior) duplicates.push(`${key} (${prior} and ${group})`);
		else scheduled.set(key, group);
	}
}

describe("scrape groups", () => {
	it("schedules every registered scraper", () => {
		// Also the backstop on the parse above: if the regex stops matching the
		// shell, the keys it drops show up here as orphans rather than as an
		// empty map that every other assertion passes against.
		const orphans = Object.keys(SCRAPERS).filter((k) => !scheduled.has(k));
		assert.deepEqual(
			orphans,
			[],
			`registered but in no scrape group, so nothing will ever run them: ${orphans.join(", ")}`,
		);
	});

	it("schedules nothing that is not registered", () => {
		// The other direction: a typo or a removed scraper leaves a key that
		// run-one.ts will report as "not implemented" every single run.
		const unknown = [...scheduled.keys()].filter(
			(k) => !Object.hasOwn(SCRAPERS, k),
		);
		assert.deepEqual(
			unknown,
			[],
			`scheduled but not in the registry: ${unknown.join(", ")}`,
		);
	});

	it("schedules each scraper in exactly one group", () => {
		// Two groups claiming a key means the source is fetched on both cadences,
		// which is a politeness-budget problem before it is a tidiness one.
		assert.deepEqual(
			duplicates,
			[],
			`scheduled twice: ${duplicates.join(", ")}`,
		);
	});

	it("keeps the sports scrapers on the daily group's pre-brief slot", () => {
		// Not style: cvt-scrape-daily runs 05:40 PT, ahead of the 05:50 Tier A
		// run and the 06:00 brief, so last night's scores reach the same
		// morning's edition. Moved to a later group, they would always be a day
		// behind, which no other test would notice.
		const sports = Object.keys(SCRAPERS).filter((k) => k.endsWith("-sports"));
		assert.ok(sports.length > 0, "no -sports scrapers found in the registry");
		for (const key of sports) {
			assert.equal(scheduled.get(key), "daily", `${key} should run in daily`);
		}
	});

	it("ships a systemd timer for every group", () => {
		// deploy.sh enables every deploy/systemd/cvt-*.timer it finds, so a group
		// with no unit file is a group that never runs on the droplet — the
		// 2026-08-19 failure, one level up from a missing group membership.
		assert.ok(groups.length > 0, "no groups parsed out of run-group.sh");
		for (const group of groups) {
			const service = join(
				repoRoot,
				`deploy/systemd/cvt-scrape-${group}.service`,
			);
			const timer = join(repoRoot, `deploy/systemd/cvt-scrape-${group}.timer`);
			assert.ok(existsSync(service), `${group}: no ${service}`);
			assert.ok(existsSync(timer), `${group}: no ${timer}`);
			assert.match(
				readFileSync(service, "utf8"),
				new RegExp(`run-group\\.sh ${group}\\b`),
				`cvt-scrape-${group}.service does not run the ${group} group`,
			);
		}
	});
});
