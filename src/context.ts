import type { Db } from "./db/index.ts";
import { politeFetch } from "./fetch.ts";
import type { ScraperContext, ScraperDef } from "./scrapers/types.ts";
import { extFor, readRaw, saveRaw } from "./store.ts";

export function buildContext(
	db: Db,
	def: ScraperDef,
): { ctx: ScraperContext; notes: string[] } {
	const sourceId = db.upsertSource({
		key: def.key,
		name: def.name,
		base_url: def.baseUrl,
		method: def.method,
	});
	const notes: string[] = [];
	const counts = {
		documentsFetched: 0,
		documentsNew: 0,
		itemsSeen: 0,
		itemsNew: 0,
	};

	const ctx: ScraperContext = {
		sourceId,
		db,
		counts,
		note(msg) {
			notes.push(msg);
			console.log(`  [${def.key}] ${msg}`);
		},
		fetchRaw: (url, opts) => politeFetch(url, opts),
		async fetchDocument(url, meta) {
			const prev = db.latestDocument(url);
			const res = await politeFetch(url, {
				etag: prev?.etag ?? undefined,
				lastModified: prev?.last_modified ?? undefined,
				skipRobots: meta.skipRobots,
			});
			counts.documentsFetched++;
			if (res.notModified && prev) {
				db.touchDocument(prev.id);
				return {
					documentId: prev.id,
					body: readRaw(prev.raw_path),
					fromCache: true,
					contentType: null,
					finalUrl: url,
				};
			}
			if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
			const { hash, rawPath } = saveRaw(res.body, extFor(res.contentType, url));
			const { id, isNew } = db.insertDocument({
				source_id: sourceId,
				url,
				doc_type: meta.docType,
				title: meta.title ?? null,
				meeting_date: meta.meetingDate ?? null,
				content_hash: hash,
				raw_path: rawPath,
				etag: res.etag,
				last_modified: res.lastModified,
				location: meta.location ?? null,
				event_key: meta.eventKey ?? null,
			});
			if (isNew) counts.documentsNew++;
			return {
				documentId: id,
				body: res.body,
				fromCache: !isNew,
				contentType: res.contentType,
				finalUrl: res.finalUrl,
			};
		},
		insertItem(item) {
			counts.itemsSeen++;
			const r = db.insertItem(item);
			if (r.isNew) counts.itemsNew++;
			return r;
		},
	};
	return { ctx, notes };
}
