import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CorruptionRisk, planBackfill } from "./backfill-post-topics.ts";

// This script is the one sanctioned path that rewrites a PUBLISHED post, so its
// safety property is the thing worth testing: it may add or replace `topics:`
// and must leave every other byte alone. createPost()'s immutability guard does
// not protect the corpus here — planBackfill's own verification does.

const BODY = `\nA line of prose with a --- sequence in it.\n\n---\n\n_Footer._\n`;

function post(frontmatter: string[]): string {
	return `---\n${frontmatter.join("\n")}\n---\n${BODY}`;
}

const PREVIEW = [
	'title: "Meeting Preview: Planning Commission — August 19, 2026"',
	"post_type: meeting_preview",
	"tier: A",
	'date: "2026-08-12T06:52:52.961Z"',
	'meeting_date: "2026-08-19"',
	"sources:",
	'  - "https://www.cityofchino.org/Calendar.aspx?EID=1567"',
];

describe("planBackfill", () => {
	it("appends topics last and leaves the body byte-identical", () => {
		const plan = planBackfill(post(PREVIEW));
		assert.deepEqual(plan.to, ["planning"]);
		assert.deepEqual(plan.from, []);
		assert.equal(plan.next, post([...PREVIEW, "topics:", "  - planning"]));
	});

	it("reports no change when the topics block is already correct", () => {
		const already = post([...PREVIEW, "topics:", "  - planning"]);
		const plan = planBackfill(already);
		assert.equal(plan.next, null, "an up-to-date post must not be rewritten");
		assert.deepEqual(plan.from, ["planning"]);
	});

	it("replaces a stale topics block rather than appending a second one", () => {
		const stale = post([...PREVIEW, "topics:", "  - business", "  - safety"]);
		const plan = planBackfill(stale);
		assert.deepEqual(plan.from, ["business", "safety"]);
		assert.equal(plan.next, post([...PREVIEW, "topics:", "  - planning"]));
	});

	it("removes a topics block when nothing classifies the post any more", () => {
		// A council preview names no subject, so the correct result is no block
		// at all — not an empty `topics:` key, which the schema would reject.
		const council = [
			'title: "Meeting Preview: City Council — September 1, 2026"',
			"post_type: meeting_preview",
			"tier: A",
		];
		const plan = planBackfill(post([...council, "topics:", "  - planning"]));
		assert.deepEqual(plan.to, []);
		assert.equal(plan.next, post(council));
		assert.doesNotMatch(plan.next ?? "", /topics:/);
	});

	it("classifies from source hosts, which is all a published file carries", () => {
		const tracker = [
			'title: "Business License Tracker — 2026-W34"',
			"post_type: business_tracker",
			"tier: A",
			"sources:",
			'  - "https://www.abc.ca.gov/licensing/licensing-reports/status-changes/"',
		];
		assert.deepEqual(planBackfill(post(tracker)).to, ["business"]);
	});

	it("preserves a body whose prose contains a --- delimiter", () => {
		// The frontmatter close is the FIRST `---` line; a horizontal rule in the
		// footer region must not be mistaken for it and swallowed.
		const next = planBackfill(post(PREVIEW)).next ?? "";
		assert.ok(next.endsWith(BODY), "the body must be copied through verbatim");
		assert.equal(
			next.split("\n---\n").length,
			post(PREVIEW).split("\n---\n").length,
		);
	});

	it("preserves quoted values containing escapes", () => {
		const quoted = [
			'title: "A post about \\"quoted\\" things"',
			"post_type: business_tracker",
			"tier: B",
		];
		const next = planBackfill(post(quoted)).next ?? "";
		assert.match(next, /title: "A post about \\"quoted\\" things"/);
	});

	it("refuses a file with no closing frontmatter delimiter", () => {
		assert.throws(
			() => planBackfill("---\ntitle: unterminated\npost_type: alert\n"),
			/frontmatter/,
		);
	});

	it("refuses a file with no frontmatter at all", () => {
		assert.throws(() => planBackfill("Just prose.\n"), /frontmatter/);
	});

	it("refuses a file with no post_type, rather than guessing one", () => {
		assert.throws(() => planBackfill(post(['title: "No type"'])), /post_type/);
	});

	it("signals corruption risk distinctly from an unreadable file", () => {
		// main() stops the whole run on CorruptionRisk and merely skips on a plain
		// Error, so the two must stay distinguishable by type, not by message.
		assert.ok(CorruptionRisk.prototype instanceof Error);
		try {
			planBackfill("Just prose.\n");
			assert.fail("expected a throw");
		} catch (err) {
			assert.ok(
				!(err instanceof CorruptionRisk),
				"an unparseable file is a skip, not an abort",
			);
		}
	});
});
