import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import type { GateReport } from "../gates/validators.ts";
import { ROOT } from "../store.ts";
import type { MeetingBundle } from "./bundle.ts";
import {
	type GatedRunOptions,
	gatedPostInput,
	mergeExtraFailures,
	normalizeCitations,
} from "./gate-run.ts";
import { createPost, type NewPost } from "./posts.ts";

// The generator wobbles between citation syntaxes. normalizeCitations rewrites
// the unambiguous variants into the one form Gate 1's citation check accepts, so
// a good draft is not held over formatting. It runs on every draft from every
// Tier B generator and had no tests.

describe("normalizeCitations", () => {
	test("rewrites a bare bracketed URL into a markdown link", () => {
		assert.equal(
			normalizeCitations("The council voted [https://example.gov/a]."),
			"The council voted [source](https://example.gov/a).",
		);
	});

	test("rewrites a link whose visible text is itself the URL", () => {
		assert.equal(
			normalizeCitations("[https://example.gov/a](https://example.gov/a)"),
			"[source](https://example.gov/a)",
		);
	});

	test("uses the href, not the label, when the two URLs differ", () => {
		// The href is what Gate 1 checks against the allowlist, so it must win.
		assert.equal(
			normalizeCitations("[https://wrong.example/x](https://example.gov/a)"),
			"[source](https://example.gov/a)",
		);
	});

	test("leaves a properly formed citation untouched", () => {
		const ok = "The council voted [source](https://example.gov/a).";
		assert.equal(normalizeCitations(ok), ok);
	});

	test("leaves a descriptive label untouched", () => {
		// Only a bracketed URL is unambiguous enough to rewrite; a human-written
		// label carries meaning and must survive.
		const ok = "See the [full agenda packet](https://example.gov/a).";
		assert.equal(normalizeCitations(ok), ok);
	});

	test("normalizes several citations in one draft", () => {
		const out = normalizeCitations(
			"First [https://example.gov/a] and second [https://example.gov/b].",
		);
		assert.equal(
			out,
			"First [source](https://example.gov/a) and second [source](https://example.gov/b).",
		);
	});

	test("does not touch bracketed text that is not a URL", () => {
		const ok = "The motion [as amended] carried.";
		assert.equal(normalizeCitations(ok), ok);
	});

	test("leaves a draft with no citations unchanged", () => {
		assert.equal(normalizeCitations("No links here."), "No links here.");
	});
});

// --- extraChecks -------------------------------------------------------------

// A generator whose output has a shape Gate 1 cannot see (the podcast's
// transcript contract) folds its own checks in here, so one report drives the
// repair pass, the hold reason and the dashboard.

const CLEAN: GateReport = { pass: true, failures: [], stats: { links: 2 } };

describe("mergeExtraFailures", () => {
	test("returns the report untouched when nothing extra failed", () => {
		assert.equal(mergeExtraFailures(CLEAN, []), CLEAN);
	});

	test("a passing report with an extra failure no longer passes", () => {
		const merged = mergeExtraFailures(CLEAN, [
			{ gate: "markup", detail: "not a host turn" },
		]);
		assert.equal(merged.pass, false);
		assert.deepEqual(merged.failures, [
			{ gate: "markup", detail: "not a host turn" },
		]);
	});

	test("extra failures are appended after the validators', not instead of", () => {
		const failing: GateReport = {
			pass: false,
			failures: [{ gate: "citations", detail: "no citation link" }],
			stats: {},
		};
		const merged = mergeExtraFailures(failing, [
			{ gate: "markup", detail: "not a host turn" },
		]);
		assert.deepEqual(
			merged.failures.map((f) => f.gate),
			["citations", "markup"],
		);
		assert.equal(merged.stats, failing.stats, "validator stats survive");
	});

	test("does not mutate the report it was given", () => {
		const report: GateReport = { pass: true, failures: [], stats: {} };
		mergeExtraFailures(report, [{ gate: "markup", detail: "x" }]);
		assert.equal(report.pass, true);
		assert.equal(report.failures.length, 0);
	});
});

// --- beforePublish -----------------------------------------------------------

// The post is filed twice on the beforePublish path: once from the draft,
// then again with whatever beforePublish produced. gatedPostInput is what makes
// those two filings the same post, so it is tested where it is composed.

const BUNDLE = {
	targetKey: "podcast:2026-W37",
	sourceKey: "podcast",
	bodyName: "Week in Review",
	meetingDate: "2026-09-07",
	agendaItems: [],
	votes: [],
	transcriptSegments: [],
	allowedUrls: ["https://chinovalley.today/posts/a/"],
	inputCorpus: "corpus",
} as MeetingBundle;

function options(slug: string): GatedRunOptions {
	return {
		db: openDb(":memory:"),
		bundle: BUNDLE,
		promptBody: "",
		generatorSystem: "",
		slug,
		title: "Week in Review: September 7, 2026",
		postType: "podcast",
		tier: "B",
		meetingDate: "2026-09-07",
	};
}

describe("gatedPostInput", () => {
	test("files the draft under the bundle's URLs and source key", () => {
		const o = options("gate-run-test-a");
		const input = gatedPostInput(o, "DRAFT BODY");
		assert.equal(input.bodyMd, "DRAFT BODY");
		assert.equal(input.postType, "podcast");
		assert.equal(input.tier, "B");
		assert.equal(input.meetingDate, "2026-09-07");
		assert.deepEqual(input.sources, BUNDLE.allowedUrls);
		assert.deepEqual(input.sourceKeys, ["podcast"]);
	});

	test("omits meetingDate entirely when the run has none", () => {
		const { meetingDate, ...noDate } = options("gate-run-test-b");
		assert.equal("meetingDate" in gatedPostInput(noDate, "x"), false);
	});

	test("beforePublish's fields rewrite the filed post in place", () => {
		// Exactly the composition runGatedPipeline performs on the clean-pass
		// branch: file the draft, then re-file it with the extra fields.
		const o = options("gate-run-test-audio");
		const queued = join(ROOT, "content", "queue", "gate-run-test-audio.md");
		try {
			const first = createPost(o.db, gatedPostInput(o, "DRAFT BODY"));
			assert.equal(first.outcome, "created");
			assert.match(readFileSync(queued, "utf8"), /DRAFT BODY/);

			const extra: Partial<NewPost> = {
				bodyMd: "## Opening\n\n**Maya:** Hello.",
				audio: {
					url: "https://chinovalley.today/audio/2026-w37.mp3",
					bytes: 4_200_000,
					durationSec: 512,
					chapters: [{ title: "Opening", startSec: 0 }],
				},
			};
			const second = createPost(o.db, {
				...gatedPostInput(o, "DRAFT BODY"),
				...extra,
			});
			assert.equal(second.outcome, "updated");
			assert.equal(second.filePath, first.filePath, "same file, rewritten");

			const file = readFileSync(queued, "utf8");
			assert.match(file, /audio_url: "https:\/\/chinovalley\.today\/audio\//);
			assert.match(file, /duration_sec: 512/);
			assert.match(file, /\*\*Maya:\*\* Hello\./);
			assert.doesNotMatch(file, /DRAFT BODY/, "the draft body is replaced");
		} finally {
			rmSync(queued, { force: true });
		}
	});
});
