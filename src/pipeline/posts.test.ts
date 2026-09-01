import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import { validateDraft } from "../gates/validators.ts";
import { ROOT } from "../store.ts";
import {
	createPost,
	getPost,
	glossaryFor,
	type NewPost,
	normalizeSlug,
	renderPostFile,
	transitionPost,
} from "./posts.ts";

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

describe("topics in the rendered frontmatter", () => {
	// classifyTopics is unit-tested in topics.test.ts; what matters here is that
	// renderPostFile is the single place that calls it, so no generator can ship
	// a post with no `topics:` block by forgetting to classify.
	test("emits the classified topics, last in the frontmatter", () => {
		const file = renderPostFile(post("Body."), "2026-08-15T00:00:00Z");
		assert.match(file, /\ntopics:\n {2}- business\n---\n/);
	});

	test("omits the key entirely when a post classifies to nothing", () => {
		// The schema declares `topics` optional; an empty `topics:` with no items
		// would parse as null and fail the build.
		const file = renderPostFile(
			{ ...post("Body."), postType: "daily-brief", briefDate: "2026-08-15" },
			"2026-08-15T00:00:00Z",
		);
		assert.doesNotMatch(file, /topics:/);
	});

	test("classifies from the source keys the generator passed, not the title", () => {
		const file = renderPostFile(
			{
				...post("Body."),
				postType: "meeting_preview",
				title: "Meeting Preview: Regular Meeting — August 20, 2026",
				sourceKeys: ["cvusd-board"],
			},
			"2026-08-15T00:00:00Z",
		);
		assert.match(file, /\ntopics:\n {2}- cvusd\n/);
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

// --- the published-file guard -------------------------------------------
//
// Regression for 2026-08-18: a Tier A run recreated three already-published
// previews and silently stripped their dated correction notes. createPost's
// "already published" check read the DATABASE, but the published artifact is
// the FILE, and the rows for those posts were missing — so it took the create
// path and overwrote live, hand-edited content.
//
// These exercise content/rejected/ and content/queue/, both gitignored, so a
// stray fixture can never land in the repo. The guard loop treats published and
// rejected identically, so rejected is a faithful stand-in for the real case.

describe("createPost respects a terminal post on disk with no DB row", () => {
	const slug = "zz-test-fixture-published-file-guard";
	const draft: NewPost = {
		slug,
		postType: "alert",
		tier: "A",
		title: "Fixture",
		bodyMd: "regenerated body — must never overwrite a terminal post",
		sources: ["https://example.test/fixture"],
	};

	test("skips when a rejected file exists but the database has no row", () => {
		const db = openDb(":memory:");
		const rel = join("content", "rejected", `${slug}.md`);
		const abs = join(ROOT, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, "original content a human decided on\n");
		try {
			const res = createPost(db, draft);
			assert.equal(res.outcome, "skipped");
			assert.equal(res.id, null, "no row exists, so no id may be invented");
			assert.equal(res.filePath, rel);
			// The whole point: the file on disk is untouched.
			assert.equal(
				readFileSync(abs, "utf8"),
				"original content a human decided on\n",
			);
		} finally {
			rmSync(abs, { force: true });
		}
	});

	test("creates normally when no terminal file exists", () => {
		const db = openDb(":memory:");
		const queued = join(ROOT, "content", "queue", `${slug}.md`);
		try {
			const res = createPost(db, draft);
			assert.equal(res.outcome, "created");
			assert.ok(typeof res.id === "number");
		} finally {
			rmSync(queued, { force: true });
		}
	});
});

// The site publishes a post at Astro's collection id, which its glob loader
// derives by lowercasing the filename. An ISO-week slug (2026-W36-news-digest)
// therefore published at an address the pipeline never recorded, and the daily
// brief, which links by stored slug, linked to a 404. createPost() owning the
// normalization is what keeps the row, the file and the URL one string.
describe("slug normalization", () => {
	const draft: NewPost = {
		slug: "2026-W36-news-digest",
		postType: "news_digest",
		tier: "A",
		title: "Chino Valley News Digest — 2026-W36",
		bodyMd: "- [Item](https://example.test/a) — 2026-08-27 (Chino)",
		sources: ["https://example.test/a"],
	};
	const lower = "2026-w36-news-digest";

	test("files and records an uppercase slug lowercased", () => {
		const db = openDb(":memory:");
		const queued = join(ROOT, "content", "queue", `${lower}.md`);
		try {
			const res = createPost(db, draft);
			assert.equal(res.outcome, "created");
			assert.equal(res.filePath, join("content", "queue", `${lower}.md`));
			assert.equal(getPost(db, lower)?.slug, lower);
		} finally {
			rmSync(queued, { force: true });
		}
	});

	test("re-running the generator updates in place instead of duplicating", () => {
		const db = openDb(":memory:");
		const queued = join(ROOT, "content", "queue", `${lower}.md`);
		try {
			createPost(db, draft);
			// The second run is the one that mattered: a normalized write plus an
			// un-normalized lookup would have missed the row and made a twin.
			const again = createPost(db, { ...draft, bodyMd: "- second run" });
			assert.equal(again.outcome, "updated");
			const rows = db.raw
				.prepare("SELECT COUNT(*) c FROM posts")
				.get() as unknown as { c: number };
			assert.equal(rows.c, 1);
		} finally {
			rmSync(queued, { force: true });
		}
	});

	test("a caller holding the pre-normalization slug still finds the post", () => {
		const db = openDb(":memory:");
		const queued = join(ROOT, "content", "queue", `${lower}.md`);
		const published = join(ROOT, "content", "published", `${lower}.md`);
		try {
			createPost(db, draft);
			// tiera/run.ts transitions using the generator's own string.
			const row = transitionPost(db, draft.slug, "published");
			assert.equal(row.slug, lower);
			assert.equal(row.file_path, join("content", "published", `${lower}.md`));
		} finally {
			rmSync(queued, { force: true });
			rmSync(published, { force: true });
		}
	});

	test("leaves an already-lowercase slug alone", () => {
		assert.equal(normalizeSlug(lower), lower);
	});

	// Between deploying normalization and running the migration, rows written
	// earlier are still stored mixed-case. The digest generator re-runs the
	// current week's slug every morning, so a lookup that missed the legacy row
	// would insert a second one the very next day.
	test("finds a row still stored under its pre-migration mixed-case slug", () => {
		const db = openDb(":memory:");
		const legacy = join(ROOT, "content", "queue", `${draft.slug}.md`);
		try {
			// Written the way the pipeline wrote it before normalization existed.
			db.raw
				.prepare(
					`INSERT INTO posts (slug, post_type, tier, status, file_path, source_count, created_at)
					 VALUES (?, 'news_digest', 'A', 'queued', ?, 1, '2026-08-31T00:00:00.000Z')`,
				)
				.run(draft.slug, join("content", "queue", `${draft.slug}.md`));

			assert.equal(getPost(db, lower)?.slug, draft.slug);

			const res = createPost(db, draft);
			assert.equal(res.outcome, "updated", "must not insert a second row");
			// Updated at the path it already has; the migration renames it later.
			assert.equal(res.filePath, join("content", "queue", `${draft.slug}.md`));
			const count = db.raw
				.prepare("SELECT COUNT(*) c FROM posts")
				.get() as unknown as { c: number };
			assert.equal(count.c, 1);
		} finally {
			rmSync(legacy, { force: true });
		}
	});

	// The published artifact is the FILE. A terminal post written before
	// normalization sits at its mixed-case filename on a case-sensitive
	// filesystem, and probing only the normalized name would recreate it.
	test("sees a terminal file left under the pre-migration filename", () => {
		const db = openDb(":memory:");
		const rel = join("content", "published", `${draft.slug}.md`);
		const abs = join(ROOT, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, "the published post, at its legacy name\n");
		try {
			const res = createPost(db, draft);
			assert.equal(res.outcome, "skipped");
			assert.equal(res.id, null);
			// Which SPELLING comes back depends on the filesystem: a
			// case-insensitive one (macOS) matches the normalized probe against
			// the mixed-case file and reports that, while the droplet's
			// case-sensitive one only matches the legacy name. Both are correct,
			// and the property under test is that neither recreates the post.
			assert.equal(res.filePath.toLowerCase(), rel.toLowerCase());
			assert.equal(
				readFileSync(abs, "utf8"),
				"the published post, at its legacy name\n",
			);
		} finally {
			rmSync(abs, { force: true });
		}
	});
});
