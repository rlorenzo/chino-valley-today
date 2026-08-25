import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { archiveHashFromUrl } from "../../site/src/lib/archive.ts";
import { archivePath, archiveUrl, SITE_ORIGIN } from "../pipeline/site-url.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const HASH = "23b0f52d7f0cbeca19683f03c41151561fc27ff5ecc3ffccd9d9fda78fb81491";

describe("archive citation URLs", () => {
	// THE DRIFT THIS EXISTS TO CATCH.
	//
	// The pipeline mints a citation and bakes it into a post's frontmatter,
	// permanently; Astro serves the page that citation resolves to. The two
	// halves cannot import each other, so the origin is declared twice. If they
	// ever disagree, every alert post published in between cites a host that
	// does not serve the site — and nothing else in the build would say so,
	// because both halves are individually correct.
	test("the pipeline and astro.config.mjs agree on the site origin", () => {
		const config = readFileSync(
			join(repoRoot, "site/astro.config.mjs"),
			"utf8",
		);
		const match = config.match(/CVT_SITE_ORIGIN\s*\?\?\s*"(https:\/\/[^"]+)"/);
		assert.ok(match, "astro.config.mjs no longer defaults CVT_SITE_ORIGIN");
		assert.equal(
			SITE_ORIGIN,
			process.env.CVT_SITE_ORIGIN ?? match[1],
			"src/pipeline/site-url.ts and site/astro.config.mjs disagree on the origin",
		);
	});

	test("trailing slash matches the site's trailingSlash: always", () => {
		assert.equal(archivePath(HASH), `/source/${HASH}/`);
	});

	test("the fragment carries the record's own identifier", () => {
		assert.equal(
			archiveUrl(HASH, "urn:oid:2.49.0.1.840.0.aaa.002.1"),
			`${SITE_ORIGIN}/source/${HASH}/#urn:oid:2.49.0.1.840.0.aaa.002.1`,
		);
		assert.equal(archiveUrl(HASH), `${SITE_ORIGIN}/source/${HASH}/`);
		assert.equal(archiveUrl(HASH, null), `${SITE_ORIGIN}/source/${HASH}/`);
	});

	// A citation is written once and read forever. Minting one from something
	// that is not a content hash produces a URL that will 404 on the live site,
	// so it has to fail where it is minted.
	test("anything that is not a bare sha256 throws rather than minting a 404", () => {
		assert.throws(() => archivePath("../../etc/passwd"));
		assert.throws(() => archivePath(HASH.toUpperCase()));
		assert.throws(() => archivePath(HASH.slice(0, 63)));
		assert.throws(() => archivePath(""));
	});

	// The build's own guard reads citations back out of published frontmatter to
	// check every one has a page. It has to recognise exactly what the pipeline
	// writes, or the guard passes on citations it never actually checked.
	test("the build guard reads back what the pipeline mints", () => {
		assert.equal(archiveHashFromUrl(archiveUrl(HASH)), HASH);
		assert.equal(archiveHashFromUrl(archiveUrl(HASH, "urn:oid:1.2.3")), HASH);
	});

	test("the guard ignores URLs that are not archive pages", () => {
		assert.equal(archiveHashFromUrl("https://api.weather.gov/alerts/1"), null);
		assert.equal(
			archiveHashFromUrl(
				"https://chinovalley.today/posts/2026-w34-news-digest/",
			),
			null,
		);
		assert.equal(archiveHashFromUrl(`${SITE_ORIGIN}/source/notahash/`), null);
	});
});
