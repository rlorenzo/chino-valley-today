// Where the published site lives, and the archive-page URLs the pipeline mints
// against it.
//
// astro.config.mjs reads the SAME env var with the SAME default, and it has to:
// a citation minted here is baked into a post's frontmatter and never revisited,
// so minting https://chinovalley.today/source/... while the build is published
// to the interim host would cite a domain that does not answer yet. The two
// halves cannot import each other — astro.config.mjs is loaded by Astro, this
// file by the pipeline — so src/site/archive-url.test.ts asserts they agree.
export const SITE_ORIGIN =
	process.env.CVT_SITE_ORIGIN ?? "https://chinovalley.today";

/**
 * The site path for one archived document, named by the sha256 of its bytes.
 *
 * The hash is the whole address: the URL cannot drift onto different content
 * the way the source's own URL can, which is the entire point of citing it.
 * Anything that is not a bare sha256 is a bug in the caller, not a page to
 * generate, so it throws rather than minting a citation that will 404.
 */
export function archivePath(contentHash: string): string {
	if (!/^[0-9a-f]{64}$/.test(contentHash)) {
		throw new Error(`not a content hash: ${contentHash}`);
	}
	return `/source/${contentHash}/`;
}

/**
 * The absolute citation URL for an archived document, optionally pointing at
 * one record inside it.
 *
 * `anchor` is the record's OWN identifier as the source issues it — for an NWS
 * alert, the CAP `id` (`urn:oid:2.49.0.1.840.0.<hash>.002.1`), which is also
 * what items.external_id holds. It is long and ugly in a URL bar, and it is
 * deliberately not shortened: a derived anchor would be a second naming scheme
 * to keep in step across the pipeline and the site, and the failure mode of
 * drifting apart is a citation that lands on the right document and the wrong
 * record. Colons and dots are legal in a URI fragment (RFC 3986) and in an HTML
 * id, so this needs no encoding on either side.
 */
export function archiveUrl(
	contentHash: string,
	anchor?: string | null,
): string {
	const base = `${SITE_ORIGIN}${archivePath(contentHash)}`;
	return anchor ? `${base}#${anchor}` : base;
}

/**
 * The anchor for one row of an archived ABC licence report.
 *
 * The row's 1-based position in the report table, which the scraper records as
 * meta.row_index and the archive page renders as the section id. Position
 * rather than licence number because a licence can appear more than once in a
 * single report — 78 of 410 rows in the 2026-08-12 status-changes report repeat
 * a number — and a number-based anchor would send a citation about one status
 * change to a different one.
 *
 * Null when the item predates row_index, so the citation degrades to the
 * document page rather than to a fragment that matches nothing.
 * site/src/components/ArchivedLicenseReport.astro is the other half of this
 * agreement; src/site/abc-render.test.ts asserts the two agree.
 */
export function licenseRowAnchor(rowIndex: unknown): string | null {
	return typeof rowIndex === "number" &&
		Number.isInteger(rowIndex) &&
		rowIndex > 0
		? `row-${rowIndex}`
		: null;
}
