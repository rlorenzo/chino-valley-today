import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import { createPost, transitionPost } from "../pipeline/posts.ts";
import { ROOT } from "../store.ts";
import {
	checkPodcastDatabase,
	expectedPodcastSlug,
	stalePodcastHealthText,
} from "./health.ts";

// Pacific is UTC-7 in September, so 14:00 PDT is 21:00Z.
const MON_0900 = new Date("2026-09-07T16:00:00.000Z");
const MON_1359 = new Date("2026-09-07T20:59:00.000Z");
const MON_1400 = new Date("2026-09-07T21:00:00.000Z");
const WED = new Date("2026-09-09T19:00:00.000Z");
const SUN = new Date("2026-09-13T19:00:00.000Z");

// 2026-09-07 is the Monday of ISO week 37; the week before it is 36.
const THIS_WEEK = "2026-w37-podcast";
const LAST_WEEK = "2026-w36-podcast";

describe("expectedPodcastSlug", () => {
	test("Monday before 14:00 Pacific still expects last week's episode", () => {
		// This week's is not due yet; calling it missing would alert on a show
		// that is running perfectly.
		assert.equal(expectedPodcastSlug(MON_0900), LAST_WEEK);
		assert.equal(expectedPodcastSlug(MON_1359), LAST_WEEK);
	});

	test("Monday at 14:00 Pacific expects this week's", () => {
		assert.equal(expectedPodcastSlug(MON_1400), THIS_WEEK);
	});

	test("mid-week expects the Monday that just passed", () => {
		assert.equal(expectedPodcastSlug(WED), THIS_WEEK);
	});

	test("Sunday still expects the Monday that opened the current week", () => {
		// Sunday closes the week the Monday opened, so the episode published on
		// that Monday is the one that should be live all week.
		assert.equal(expectedPodcastSlug(SUN), THIS_WEEK);
	});

	test("is lowercased, the way createPost files it", () => {
		assert.equal(
			expectedPodcastSlug(WED),
			expectedPodcastSlug(WED).toLowerCase(),
		);
	});

	test("crosses a year boundary on the ISO week's own rule", () => {
		// 2027-01-04 is the Monday of ISO week 1 of 2027; the week before it is
		// 2026-W53, not 2027-W00.
		assert.equal(
			expectedPodcastSlug(new Date("2027-01-04T22:00:00.000Z")),
			"2027-w01-podcast",
		);
		assert.equal(
			expectedPodcastSlug(new Date("2027-01-04T16:00:00.000Z")),
			"2026-w53-podcast",
		);
	});

	// THE DRIFT THIS EXISTS TO CATCH.
	//
	// The site stamps `podcast=fresh` at build time from its own copy of this
	// rule (site/src/lib/record.ts); this watchdog decides whether to flip that
	// stamp stale. If the two disagree about which week is due, a healthy site
	// gets marked stale every Monday, or a missing episode never raises the
	// alarm — and each half is individually correct, so nothing else in the
	// build would say so. Same class of split-brain as the site origin pinned
	// by src/site/archive-url.test.ts, and worth running rather than eyeballing:
	// both halves are date arithmetic with a DST-sensitive hour cutover.
	//
	// Imported dynamically, through a VARIABLE specifier, for one reason:
	// record.ts opens with `import type { CollectionEntry } from "astro:content"`,
	// which does not resolve under this project's tsconfig, so a static import
	// fails `npm run typecheck` even though the type-only line is erased at
	// runtime. A variable specifier is not followed by tsc and resolves normally
	// in node. Do not "fix" this into a static import.
	const SITE_RECORD = "../../site/src/lib/record.ts";

	test("agrees with the site's copy of the rule, hour by hour, for a year", async () => {
		const site = (await import(SITE_RECORD)) as {
			expectedPodcastSlug?: (now: Date) => string;
		};
		assert.equal(
			typeof site.expectedPodcastSlug,
			"function",
			"site/src/lib/record.ts no longer exports expectedPodcastSlug",
		);
		const siteSlug = site.expectedPodcastSlug as (now: Date) => string;

		// Every 5th hour across 371 days: covers both DST transitions, both
		// sides of the Monday 14:00 cutover, and an ISO year boundary.
		for (let h = 0; h < 24 * 371; h += 5) {
			const now = new Date(Date.UTC(2026, 0, 1, h));
			assert.equal(
				expectedPodcastSlug(now),
				siteSlug(now),
				`watchdog and site disagree at ${now.toISOString()}`,
			);
		}
	});
});

describe("stalePodcastHealthText", () => {
	const HEALTH = [
		"ok",
		"built=2026-09-07T13:30:00.000Z",
		"posts=412",
		"latest_brief=2026-09-07",
		"pipeline=fresh",
		"latest_podcast=2026-w36-podcast",
		"podcast=fresh",
		"",
	].join("\n");

	test("flips both markers, so the one existing monitor fires", () => {
		const out = stalePodcastHealthText(HEALTH);
		assert.ok(out !== null);
		assert.match(out, /^podcast=stale$/m);
		assert.match(out, /^pipeline=stale$/m);
		assert.doesNotMatch(out, /=fresh/);
	});

	test("changes nothing else on the page", () => {
		const out = stalePodcastHealthText(HEALTH) as string;
		assert.equal(
			out
				.replace("podcast=stale", "podcast=fresh")
				.replace("pipeline=stale", "pipeline=fresh"),
			HEALTH,
		);
	});

	test("flips the pipeline marker even on a page with no podcast marker", () => {
		// The site's health page gained `podcast=` in the same change as this
		// watchdog; an older build serving without it must still raise the alarm.
		const older = HEALTH.replace("podcast=fresh\n", "");
		const out = stalePodcastHealthText(older);
		assert.ok(out !== null);
		assert.match(out, /^pipeline=stale$/m);
	});

	test("flips the podcast marker even when the pipeline is already stale", () => {
		// The brief's watchdog ran first this morning. Its flip must not mask
		// the episode's own honest report.
		const out = stalePodcastHealthText(
			HEALTH.replace("pipeline=fresh", "pipeline=stale"),
		);
		assert.ok(out !== null);
		assert.match(out, /^podcast=stale$/m);
	});

	test("returns null when there is nothing left to flip", () => {
		assert.equal(
			stalePodcastHealthText(
				HEALTH.replace("pipeline=fresh", "pipeline=stale").replace(
					"podcast=fresh",
					"podcast=stale",
				),
			),
			null,
		);
		assert.equal(stalePodcastHealthText("not a health page at all"), null);
	});
});

describe("checkPodcastDatabase", () => {
	function db() {
		return openDb(":memory:");
	}
	// A week with no real episode on disk: createPost refuses to file a slug
	// that already exists in content/published/, and 2026-w37 does.
	const WED_W11 = new Date("2026-03-11T19:00:00.000Z");
	const W11 = "2026-w11-podcast";

	// createPost writes a REAL markdown file under content/. Left behind, it is
	// a fabricated episode the next site build would publish.
	function cleanup(): void {
		for (const dir of ["queue", "held", "published"]) {
			rmSync(join(ROOT, "content", dir, `${W11}.md`), { force: true });
		}
	}

	test("reports absent when the episode was never generated", () => {
		const check = checkPodcastDatabase(db(), WED_W11);
		assert.deepEqual(
			{ ok: check.ok, status: check.status, slug: check.slug },
			{ ok: false, status: "absent", slug: W11 },
		);
	});

	test("reports the status of an episode that exists but did not publish", () => {
		const d = db();
		try {
			createPost(d, {
				slug: W11,
				postType: "podcast",
				tier: "B",
				title: "Week in Review",
				bodyMd: "Body.",
				sources: ["https://chinovalley.today/posts/a/"],
			});
			const check = checkPodcastDatabase(d, WED_W11);
			assert.equal(check.ok, false);
			assert.equal(check.status, "queued");
		} finally {
			cleanup();
		}
	});

	test("is ok only once the episode is published", () => {
		const d = db();
		try {
			createPost(d, {
				slug: W11,
				postType: "podcast",
				tier: "B",
				title: "Week in Review",
				bodyMd: "Body.",
				sources: ["https://chinovalley.today/posts/a/"],
			});
			transitionPost(d, W11, "held", { heldReason: "audio: ffmpeg failed" });
			const held = checkPodcastDatabase(d, WED_W11);
			assert.equal(held.ok, false, "held is not published");
			assert.equal(held.heldReason, "audio: ffmpeg failed");
			transitionPost(d, W11, "published");
			assert.equal(checkPodcastDatabase(d, WED_W11).ok, true);
		} finally {
			cleanup();
		}
	});
});
