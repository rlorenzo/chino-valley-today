import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The assembler folds a holiday's closure notices into ONE events_ahead row
// (see railEntries in src/pipeline/daily-brief.ts) and hands the site the whole
// list of who is closed in `closed`. The fold is only honest if the page draws
// a link for every entry in that list: /calendar/ tells the reader "Every entry
// links to its calendar listing", and a page that rendered only the row's flat
// `url` would quietly cost them the four other listings the row stands for.
//
// Nothing else in this suite renders Astro, so a page that stopped drawing
// those links would ship green. These read the templates as text — coarse, but
// it is the difference between a promise kept and a promise printed.

const repoRoot = join(import.meta.dirname, "..", "..");
const PAGES = [
	{ path: "site/src/pages/calendar.astro", venueClass: "cal__closed" },
	{ path: "site/src/pages/index.astro", venueClass: "today__rail-closed" },
];

test("a folded closure notice keeps its own link on every page that draws one", () => {
	for (const page of PAGES) {
		const src = readFileSync(join(repoRoot, page.path), "utf8");
		const label = `${page.path}: `;
		// The row is drawn from `closed`, not from the flat `url` alone.
		assert.match(src, /e\.closed\.map\(/, `${label}closed[] is never mapped`);
		assert.match(
			src,
			/<a href=\{place\.url\}/,
			`${label}a folded notice gets no link of its own`,
		);
		assert.match(
			src,
			/\{place\.label\}/,
			`${label}a link is drawn with no name on it`,
		);
		assert.match(
			src,
			new RegExp(`class="${page.venueClass}"`),
			`${label}the closure line is unstyled`,
		);
	}
});

test("the calendar page still makes the promise the links keep", () => {
	// If this sentence is ever reworded, the test above is what says whether
	// the page can still make the claim.
	const src = readFileSync(
		join(repoRoot, "site/src/pages/calendar.astro"),
		"utf8",
	);
	assert.match(src, /Every entry links to its calendar listing/);
});
