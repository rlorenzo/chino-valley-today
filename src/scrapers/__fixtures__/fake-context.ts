// An in-memory ScraperContext for testing scraper `run` orchestration —
// discovery order, fallbacks, per-article error recovery — without HTTP or a
// database. Only the members a press scraper actually touches are implemented;
// the rest throw rather than returning a plausible-looking empty value, so a
// test that drifts into untested territory fails instead of passing quietly.

import type { RawResult } from "../../fetch.ts";
import type {
	FetchedDocument,
	NewItemInput,
	ScraperContext,
} from "../types.ts";

/** A canned response: body text for 200, an Error to throw, or an explicit status. */
export type FakeResponse =
	| string
	| Error
	| { status: number; body?: string; finalUrl?: string };

export interface FakeScraperContext {
	ctx: ScraperContext;
	/** Items handed to insertItem, in order. */
	items: NewItemInput[];
	/** Messages passed to ctx.note, in order. */
	notes: string[];
	/** Every URL requested, in order, across fetchRaw and fetchDocument. */
	requested: string[];
}

function toRawResult(url: string, response: FakeResponse): RawResult {
	if (response instanceof Error) throw response;
	const { status, body, finalUrl } =
		typeof response === "string"
			? { status: 200, body: response, finalUrl: url }
			: {
					status: response.status,
					body: response.body ?? "",
					finalUrl: response.finalUrl ?? url,
				};
	return {
		status,
		ok: status >= 200 && status < 300,
		notModified: status === 304,
		body: Buffer.from(body, "utf8"),
		etag: null,
		lastModified: null,
		contentType: "text/html",
		finalUrl,
	};
}

/**
 * Builds a context whose fetches are served from `responses`, keyed by URL. A
 * URL with no entry throws, because a scraper reaching for a page the test did
 * not anticipate is the bug the test exists to catch.
 */
export function fakeScraperContext(
	responses: Record<string, FakeResponse>,
): FakeScraperContext {
	const items: NewItemInput[] = [];
	const notes: string[] = [];
	const requested: string[] = [];
	let nextDocumentId = 1;
	let nextItemId = 1;

	const fetchRaw = async (url: string): Promise<RawResult> => {
		requested.push(url);
		const response = responses[url];
		if (response === undefined) {
			throw new Error(`fake context: no response registered for ${url}`);
		}
		return toRawResult(url, response);
	};

	const ctx = {
		sourceId: 1,
		get db(): never {
			throw new Error("fake context: db access is not stubbed");
		},
		counts: {
			documentsFetched: 0,
			documentsNew: 0,
			itemsSeen: 0,
			itemsNew: 0,
		},
		fetchRaw,
		async fetchDocument(url: string): Promise<FetchedDocument> {
			const res = await fetchRaw(url);
			// Mirrors buildContext, which throws rather than handing a scraper an
			// error page to parse.
			if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
			return {
				documentId: nextDocumentId++,
				body: res.body,
				fromCache: false,
				contentType: res.contentType,
				finalUrl: res.finalUrl,
			};
		},
		insertItem(item: NewItemInput) {
			items.push(item);
			return { id: nextItemId++, isNew: true };
		},
		note(msg: string) {
			notes.push(msg);
		},
	} as unknown as ScraperContext;

	return { ctx, items, notes, requested };
}
