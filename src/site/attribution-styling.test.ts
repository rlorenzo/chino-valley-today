import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The site is built by Astro and never imported by the pipeline, so nothing
// else in this suite would notice if the one visual rule the editorial policy
// actually depends on quietly broke. Violet ink (--stamp, #5b2d8e) marks a
// PRIMARY public record. Secondary press attribution wears crate outline and
// must never borrow the violet vocabulary, because a reader who learns that
// violet means "I can follow this to the source document" is being misled the
// moment a newspaper headline wears it too.

const repoRoot = join(import.meta.dirname, "..", "..");
const css = readFileSync(join(repoRoot, "site/src/styles/world.css"), "utf8");
const postArticle = readFileSync(
	join(repoRoot, "site/src/components/PostArticle.astro"),
	"utf8",
);

/** Returns the declaration body of the first rule with exactly this selector. */
function ruleBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(
		new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"),
	);
	assert.ok(match, `no CSS rule found for selector: ${selector}`);
	return match[1];
}

test("attribution styling keeps violet reserved for primary records", async (t) => {
	await t.test("the attribution stamp carries no violet ink", () => {
		const body = ruleBody(".stamp--attribution");
		assert.match(body, /color:\s*var\(--crate\)/);
		assert.doesNotMatch(body, /var\(--stamp\)/);
		assert.doesNotMatch(body, /#5b2d8e/i);
	});

	await t.test("the attribution stamp drops the provenance dot", () => {
		// The circular ::before dot is the provenance mark itself. Tinting it
		// crate is not enough; a secondary link must not wear the mark at all.
		const body = ruleBody(".stamp--attribution::before");
		assert.match(body, /content:\s*none/);
	});

	await t.test("the attribution stamp stands alone, not on .stamp", () => {
		// If it rode on .stamp, any violet property added to .stamp later would
		// silently reach secondary press links.
		const body = ruleBody(".stamp--attribution");
		assert.match(body, /display:\s*inline-flex/);
		assert.match(body, /border:\s*1\.5px\s+solid\s+var\(--crate-line\)/);

		assert.doesNotMatch(
			postArticle,
			/class="stamp stamp--attribution"/,
			"secondary press links must not also carry the violet .stamp class",
		);
		assert.match(postArticle, /class="stamp--attribution"/);
	});

	await t.test(
		"headline links wrap instead of blowing out the viewport",
		() => {
			// Article headlines routinely exceed 60-80 characters; badge styling
			// (inline-flex + nowrap) breaks narrow viewports horizontally.
			const body = ruleBody(".prose .headlines-elsewhere a");
			assert.match(body, /display:\s*inline\b/);
			assert.match(body, /white-space:\s*normal/);
			assert.match(body, /color:\s*var\(--crate\)/);
			assert.doesNotMatch(body, /inline-flex/);
			assert.doesNotMatch(body, /nowrap/);
		},
	);

	await t.test("the blanket prose citation rule exempts headline links", () => {
		// Every outbound link in prose is auto-stamped violet as a citation.
		// That is exactly what must NOT happen to a press headline, and the
		// :not(.headline-link) guard is the only thing preventing it.
		assert.match(css, /\.prose a\[href\^="http"\]:not\(\.headline-link\)/);
	});

	await t.test("counts report primary and secondary separately", () => {
		// Folding attributions into the source count inflates the provenance
		// claim the inspection panel is making.
		assert.doesNotMatch(postArticle, /sources\.length \+ attributions\.length/);
		assert.match(postArticle, /attributionCount/);
	});
});
