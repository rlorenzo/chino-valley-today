import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateDraft } from "../gates/validators.ts";
import { glossaryFor, type NewPost, renderPostFile } from "./posts.ts";

const SOURCE =
	"https://www.abc.ca.gov/licensing/licensing-reports/status-changes/";

function post(bodyMd: string): NewPost {
	return {
		slug: "s",
		postType: "business_tracker",
		tier: "B",
		title: "t",
		bodyMd,
		sources: [SOURCE],
	};
}

// Everything after the YAML frontmatter block — body + hr + glossary + footer,
// which is what the gates actually see.
function gateBody(file: string): string {
	return file.split(/^---$/m).slice(2).join("---").trim();
}

describe("record-code glossary", () => {
	test("includes only the codes the post actually uses", () => {
		const g = glossaryFor(
			"License 399692, Type 20, changed from ACTIVE to REVPEN per ABC.",
		);
		assert.match(g, /ABC —/);
		assert.match(g, /Type 20 —/);
		assert.match(g, /ACTIVE —/);
		assert.match(g, /REVPEN —/);
		assert.doesNotMatch(
			g,
			/Type 41/,
			"a code the post never mentions must not be glossed",
		);
		assert.doesNotMatch(g, /SURREND/);
	});

	test("is empty when the post uses no record codes", () => {
		assert.equal(glossaryFor("The council voted to approve the contract."), "");
	});

	test("REVPEN is glossed without implying the licence is gone", () => {
		// The record says the process has begun, not that it finished. Wording that
		// implied an outcome would be both wrong and a characterization.
		const g = glossaryFor("changed from ACTIVE to REVPEN");
		assert.match(g, /revocation pending/i);
		assert.match(g, /not revoked/i);
	});
});

describe("glossary placement in the rendered post", () => {
	test("sits after the final hr, with the disclosure line still in that region", () => {
		const file = renderPostFile(
			post("Type 41 licensee moved ACTIVE to REVPEN."),
			"2026-08-15T00:00:00Z",
		);
		const lastHr = file.lastIndexOf("\n---\n");
		const trailing = file.slice(lastHr);
		assert.match(
			trailing,
			/What the record codes mean/,
			"glossary must be inside the footer region",
		);
		assert.match(
			trailing,
			/Generated from public records/,
			"the footer marker must remain in that region",
		);
	});

	test("introduces no horizontal rule of its own", () => {
		// A second hr would become the LAST hr and push the disclosure marker out of
		// the matched trailing text, un-exempting the glossary.
		const file = renderPostFile(
			post("Type 41 ACTIVE to REVPEN."),
			"2026-08-15T00:00:00Z",
		);
		const body = gateBody(file);
		assert.equal(
			body.match(/^---$/gm)?.length ?? 0,
			1,
			"exactly one hr, the footer separator",
		);
	});

	test("a post with no codes renders the plain footer unchanged", () => {
		const file = renderPostFile(
			post("The council approved the contract."),
			"2026-08-15T00:00:00Z",
		);
		assert.doesNotMatch(file, /What the record codes mean/);
		assert.match(file, /Generated from public records/);
	});
});

describe("the glossary is invisible to the gates", () => {
	// The whole reason it lives in the footer: "California Department of
	// Alcoholic Beverage Control" is a proper name absent from the corpus, and
	// the definitions carry no citation links. In the body either would hold the
	// draft — the same Gate 1c failure that held 2026-W33 on "Two ABC".
	const body =
		"Two licenses in Chino moved to REVPEN status on the ABC status-change report " +
		`[source](${SOURCE}).\n\n` +
		`- License 399692, Type 20, changed from ACTIVE to REVPEN [source](${SOURCE}).`;
	const corpus = body;

	test("adding it changes no gate outcome and no gate statistic", () => {
		const withGlossary = validateDraft({
			bodyMd: gateBody(renderPostFile(post(body), "2026-08-15T00:00:00Z")),
			allowedUrls: [SOURCE],
			inputCorpus: corpus,
		});
		const withoutGlossary = validateDraft({
			bodyMd: body,
			allowedUrls: [SOURCE],
			inputCorpus: corpus,
		});

		assert.equal(
			withoutGlossary.pass,
			true,
			"precondition: the bare body passes",
		);
		assert.equal(
			withGlossary.pass,
			true,
			"the glossary must not hold the draft",
		);

		// blocksTotal counts every parsed block, footer ones included, so it does
		// rise — that is the glossary being parsed and then excluded. Every stat
		// describing what was actually SCANNED must be untouched.
		const { blocksTotal: totalWith, ...scannedWith } = withGlossary.stats;
		const { blocksTotal: totalWithout, ...scannedWithout } =
			withoutGlossary.stats;
		assert.deepEqual(
			scannedWith,
			scannedWithout,
			"the glossary must be scanned by nothing",
		);
		assert.ok(
			totalWith > totalWithout,
			"the glossary blocks are parsed, just classified as footer",
		);
	});

	test("no glossary term is ever reported as an unknown name", () => {
		const r = validateDraft({
			bodyMd: gateBody(renderPostFile(post(body), "2026-08-15T00:00:00Z")),
			allowedUrls: [SOURCE],
			inputCorpus: corpus,
		});
		const names = r.failures
			.filter((f) => f.gate === "proper_names")
			.map((f) => f.detail);
		assert.equal(
			names.some((d) => d.includes("Alcoholic Beverage Control")),
			false,
		);
	});
});
