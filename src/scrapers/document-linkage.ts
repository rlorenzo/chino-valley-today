import type { ScraperContext } from "./types.ts";

// Some sources serve a document whose bytes change on every fetch even when
// nothing meaningful changed: CivicPlus RSSFeed.aspx embeds a live
// <lastBuildDate>, and the Sheriff's news page carries a rotating token. Those
// documents never hash-match across runs, so each run mints a fresh documents
// row. Naively linking items to that fresh document_id would make every item
// look "new" on every run.
//
// This looks up whether an item with this external_id already exists (from ANY
// earlier document under the same source) and, if so, reuses ITS document_id, so
// insertItem updates in place. Each run's fetch is still archived as its own
// real document — accurately reflecting that the resource changed — and only the
// item's linkage is pinned to where it was first captured.
//
// Lived in three scrapers verbatim (both CivicPlus RSS scrapers and
// sbsheriff-news) before this module.
//
// NOTE: insertItem now resolves item identity as (document url, item_type,
// external_id), which already covers this case — a re-fetch is the same url with
// new bytes, so it matches centrally. This helper is therefore redundant, and is
// kept only to preserve today's exact linkage behaviour: items stay pinned to
// the FIRST document rather than being repointed to the newest. Removing it is a
// behaviour change and is tracked separately, not folded into a de-duplication
// refactor.
export function resolveDocumentId(
	ctx: ScraperContext,
	freshDocumentId: number,
	externalId: string,
	itemType: string,
): number {
	const row = ctx.db.raw
		.prepare(
			`SELECT i.document_id AS documentId FROM items i
       JOIN documents d ON i.document_id = d.id
       WHERE i.external_id = ? AND i.item_type = ? AND d.source_id = ?
       ORDER BY i.id DESC LIMIT 1`,
		)
		.get(externalId, itemType, ctx.sourceId) as
		| { documentId: number }
		| undefined;
	return row?.documentId ?? freshDocumentId;
}
