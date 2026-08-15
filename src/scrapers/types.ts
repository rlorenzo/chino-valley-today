import type { Db } from "../db/index.ts";
import type { FetchOpts, RawResult } from "../fetch.ts";

export type FetchMethod = "api" | "rss" | "html" | "pdf" | "captions" | "email";

// Recommended doc_type values: 'agenda','minutes','packet','video','captions',
// 'news_release','alert','license_report','feed','listing'
// Recommended item_type values: 'agenda_item','vote','news_release','alert',
// 'license_event','transcript_segment','event'

export interface ScraperCounts {
	documentsFetched: number;
	documentsNew: number;
	itemsSeen: number;
	itemsNew: number;
}

export interface FetchedDocument {
	documentId: number;
	body: Buffer;
	fromCache: boolean;
	contentType: string | null;
	finalUrl: string;
}

export interface NewItemInput {
	document_id: number;
	source_url: string; // the deepest stable link a READER should click; never empty
	item_type: string;
	// Required — see NewItem in db/index.ts. Item identity is (document url,
	// item_type, external_id); without one an item duplicates on every run.
	// Derive a stable id if the source lacks a native one.
	external_id: string;
	title?: string | null;
	body?: string | null;
	meta?: unknown; // JSON-serializable
	occurred_at?: string | null; // ISO date/datetime
}

export interface ScraperContext {
	sourceId: number;
	db: Db;
	counts: ScraperCounts;
	// Polite fetch WITHOUT archiving (probing endpoints, listing pages you discard).
	fetchRaw: (url: string, opts?: FetchOpts) => Promise<RawResult>;
	// Polite fetch + raw archive + documents row. Handles conditional GET and
	// dedup by content hash; returns cached body on 304. Use for anything a
	// stored item will reference.
	fetchDocument: (
		url: string,
		meta: {
			docType: string;
			title?: string;
			meetingDate?: string;
			location?: string; // meeting location when the source provides one
			eventKey?: string; // source-native event id (Legistar EventId etc.)
			// ONLY for documented public APIs whose robots.txt targets crawlers, not
			// API clients (e.g. api.weather.gov's blanket Disallow). Note the
			// justification via ctx.note() when used.
			skipRobots?: boolean;
		},
	) => Promise<FetchedDocument>;
	insertItem: (item: NewItemInput) => { id: number; isNew: boolean };
	// Data-quality observations, failure modes, open questions -> POC report.
	note: (msg: string) => void;
}

export interface ScraperDef {
	key: string;
	name: string;
	baseUrl: string;
	method: FetchMethod;
	// args: extra CLI arguments forwarded by run-one.ts (`npm run one <key> -- <args>`),
	// for scraper-specific modes like targeted backfills. Absent in poc runs.
	run: (ctx: ScraperContext, args?: string[]) => Promise<void>;
}
