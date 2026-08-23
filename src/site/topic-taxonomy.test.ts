import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { TOPIC_SLUGS } from "../pipeline/topics.ts";

// Topics are classified by the pipeline and rendered by the site, and the two
// halves cannot import each other: the site's record.ts is Astro-scoped (it
// imports `astro:content`), so the taxonomy is necessarily declared twice.
//
// That duplication is the whole risk. If the pipeline starts emitting a slug
// the site does not display, those posts vanish from every topic page while
// still carrying the topic in frontmatter — filed, invisible, and nothing
// fails. If the site displays a slug the pipeline never emits, the front page
// advertises a shelf that can never fill. Neither shows up in a build error,
// so it is asserted here.

const repoRoot = join(import.meta.dirname, "..", "..");
const recordTs = readFileSync(join(repoRoot, "site/src/lib/record.ts"), "utf8");
const contentConfig = readFileSync(
	join(repoRoot, "site/src/content.config.ts"),
	"utf8",
);

/** The slugs the site declares in its TOPICS display list, in order. */
function siteSlugs(): string[] {
	const block = recordTs.match(
		/export const TOPICS = \[([\s\S]*?)\] as const;/,
	);
	assert.ok(block, "site/src/lib/record.ts must export a TOPICS array");
	return [...block[1].matchAll(/slug:\s*"([a-z-]+)"/g)].map((m) => m[1]);
}

/** The slugs the content schema will accept in `topics` frontmatter. */
function schemaSlugs(): string[] {
	const block = contentConfig.match(
		/topics:\s*z\s*\.array\(\s*z\.enum\(\[([\s\S]*?)\]\)/,
	);
	assert.ok(block, "site/src/content.config.ts must declare a topics enum");
	return [...block[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

test("the site displays exactly the topics the pipeline can emit", () => {
	assert.deepEqual(
		siteSlugs(),
		[...TOPIC_SLUGS],
		"site/src/lib/record.ts TOPICS drifted from src/pipeline/topics.ts TOPIC_SLUGS",
	);
});

test("the content schema accepts exactly the topics the pipeline can emit", () => {
	// Ordering is not meaningful in a zod enum, but membership is: a slug the
	// pipeline emits and the schema rejects fails the BUILD, which is loud, and
	// the reverse is silent, which is worse.
	assert.deepEqual(
		[...schemaSlugs()].sort(),
		[...TOPIC_SLUGS].sort(),
		"site/src/content.config.ts topics enum drifted from src/pipeline/topics.ts",
	);
});

test("the site reads topics from frontmatter rather than deriving them", () => {
	// The regression this guards is a revert to title-matching. Task 4.5 moved
	// classification into the pipeline precisely because the title is the one
	// thing a generator does not promise to keep stable.
	assert.match(
		recordTs,
		/post\.data\.topics/,
		"topicsFor must read the pipeline's `topics` frontmatter",
	);
	assert.doesNotMatch(
		recordTs,
		/function topicsFor[\s\S]*?post\.data\.title/,
		"topicsFor must not classify from the post title",
	);
});
