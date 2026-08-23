import type { Db } from "./db/index.ts";
import { type FetchOpts, politeFetch } from "./fetch.ts";
import type { ScraperContext, ScraperDef } from "./scrapers/types.ts";
import { extFor, readRaw, saveRaw } from "./store.ts";

/**
 * A scraper's `fetchDefaults` record the terms its source was onboarded under —
 * fail-closed robots, manual redirect inspection, the hosts it may touch. They
 * are one-way: this merges them over a caller's options and refuses any call
 * that tries to relax one, rather than quietly letting the caller win. Shared by
 * fetchRaw and fetchDocument so the two can never enforce different rules.
 */
function applyFetchDefaults(
	def: ScraperDef,
	url: string,
	opts: FetchOpts,
): FetchOpts {
	const defaults = def.fetchDefaults;
	if (!defaults) return opts;

	const violation = (msg: string) =>
		new Error(`[${def.key}] Invariant violation: ${msg}`);

	if (
		defaults.failClosedRobots &&
		(opts.skipRobots || opts.failClosedRobots === false)
	) {
		throw violation("cannot bypass failClosedRobots");
	}
	if (defaults.manualRedirect && opts.manualRedirect === false) {
		throw violation("cannot disable manualRedirect");
	}
	const { hostname } = new URL(url);
	if (defaults.allowedHosts && !defaults.allowedHosts.includes(hostname)) {
		throw violation(`host not in allowedHosts: ${hostname}`);
	}

	return {
		...opts,
		failClosedRobots: defaults.failClosedRobots || opts.failClosedRobots,
		skipRobots: defaults.failClosedRobots ? false : opts.skipRobots,
		manualRedirect: defaults.manualRedirect || opts.manualRedirect,
		allowedHosts: defaults.allowedHosts ?? opts.allowedHosts,
		maxRedirectHops: defaults.maxRedirectHops ?? opts.maxRedirectHops,
	};
}

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
		fetchRaw: (url, opts) =>
			politeFetch(url, applyFetchDefaults(def, url, opts ?? {})),
		async fetchDocument(url, meta) {
			const prev = db.latestDocument(url);
			// A jsonBody makes this a POST, and politeFetch drops the conditional
			// headers in that case: a POST has no cached representation to
			// revalidate. So the 304 branch below stays reachable only for GETs.
			const res = await politeFetch(
				url,
				applyFetchDefaults(def, url, {
					etag: prev?.etag ?? undefined,
					lastModified: prev?.last_modified ?? undefined,
					skipRobots: meta.skipRobots,
					jsonBody: meta.jsonBody,
					bodyIsIdempotent: meta.bodyIsIdempotent,
				}),
			);
			counts.documentsFetched++;
			if (res.notModified && prev) {
				db.touchDocument(prev.id);
				return {
					documentId: prev.id,
					body: readRaw(prev.raw_path),
					fromCache: true,
					contentType: null,
					finalUrl: res.finalUrl || url,
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
