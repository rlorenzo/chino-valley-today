import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { buildContext } from "./context.ts";
import { openDb } from "./db/index.ts";
import type { ScraperDef } from "./scrapers/types.ts";

// Matches the stubbing idiom in fetch.test.ts: politeFetch caches robots.txt
// per origin for the life of the process, so the success-path test below uses
// a host none of the invariant-violation tests ever actually reach (they all
// throw inside applyFetchDefaults before politeFetch is called).
interface StubRoute {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
}

async function withStubbedFetch(
	routes: Record<string, StubRoute>,
	fn: () => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		const route = routes[url];
		if (!route) return new Response("not found", { status: 404 });
		return new Response(route.body ?? "ok", {
			status: route.status ?? 200,
			headers: route.headers,
		});
	}) as typeof globalThis.fetch;
	try {
		await fn();
	} finally {
		globalThis.fetch = original;
	}
}

const ALLOW_ALL = "User-agent: *\nAllow: /\n";

let tmpDir: string;
let dbPath: string;

before(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cvt-context-test-"));
	dbPath = join(tmpDir, "test.db");
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

test("context fetchDefaults non-relaxable invariants", async (t) => {
	const db = openDb(dbPath);

	const guardedDef: ScraperDef = {
		key: "test-guarded",
		name: "Test Guarded Scraper",
		baseUrl: "https://www.championnewspapers.com",
		method: "html",
		fetchDefaults: {
			failClosedRobots: true,
			allowedHosts: ["www.championnewspapers.com"],
			manualRedirect: true,
			maxRedirectHops: 3,
		},
		run: async () => {},
	};

	const { ctx } = buildContext(db, guardedDef);

	await t.test(
		"fetchRaw throws invariant error on off-domain host",
		async () => {
			await assert.rejects(
				async () => {
					await ctx.fetchRaw("https://evil.com/news");
				},
				{
					message: /Invariant violation: host not in allowedHosts: evil\.com/,
				},
			);
		},
	);

	await t.test(
		"fetchRaw throws invariant error when attempting to bypass failClosedRobots",
		async () => {
			await assert.rejects(
				async () => {
					await ctx.fetchRaw("https://www.championnewspapers.com/news", {
						skipRobots: true,
					});
				},
				{
					message: /Invariant violation: cannot bypass failClosedRobots/,
				},
			);
		},
	);

	await t.test(
		"fetchDocument throws invariant error on off-domain host",
		async () => {
			await assert.rejects(
				async () => {
					await ctx.fetchDocument("https://evil.com/article", {
						docType: "news_article",
					});
				},
				{
					message: /Invariant violation: host not in allowedHosts: evil\.com/,
				},
			);
		},
	);

	await t.test(
		"fetchDocument throws invariant error when attempting to skipRobots",
		async () => {
			await assert.rejects(
				async () => {
					await ctx.fetchDocument(
						"https://www.championnewspapers.com/article.html",
						{
							docType: "news_article",
							skipRobots: true,
						},
					);
				},
				{
					message: /Invariant violation: cannot bypass failClosedRobots/,
				},
			);
		},
	);

	await t.test(
		"fetchRaw throws invariant error when attempting to set failClosedRobots: false",
		async () => {
			await assert.rejects(
				async () => {
					await ctx.fetchRaw("https://www.championnewspapers.com/news", {
						failClosedRobots: false,
					});
				},
				{
					message: /Invariant violation: cannot bypass failClosedRobots/,
				},
			);
		},
	);

	// fetchDocument's meta type only ever forwards `skipRobots` into opts (see
	// context.ts's fetchDocument) -- it has no pathway for a caller to reach
	// failClosedRobots or manualRedirect at all, typed or not. So unlike the
	// skipRobots case above, those two overrides are only reachable through
	// fetchRaw's opts, which passes FetchOpts straight through.

	await t.test(
		"fetchRaw throws invariant error when attempting to disable manualRedirect",
		async () => {
			await assert.rejects(
				async () => {
					await ctx.fetchRaw("https://www.championnewspapers.com/news", {
						manualRedirect: false,
					});
				},
				{
					message: /Invariant violation: cannot disable manualRedirect/,
				},
			);
		},
	);

	await t.test(
		"fetchDocument succeeds and creates a document row when defaults are respected",
		async () => {
			const url = "https://www.championnewspapers.com/success.html";
			let doc: Awaited<ReturnType<typeof ctx.fetchDocument>> | undefined;

			await withStubbedFetch(
				{
					"https://www.championnewspapers.com/robots.txt": { body: ALLOW_ALL },
					[url]: {
						body: "<html><body>context.test.ts fixture -- success path document</body></html>",
						headers: { "content-type": "text/html" },
					},
				},
				async () => {
					doc = await ctx.fetchDocument(url, { docType: "news_article" });
				},
			);

			assert.ok(doc, "fetchDocument must resolve");
			assert.equal(doc?.fromCache, false, "a first fetch is not a cache hit");
			assert.ok(doc?.documentId, "a documentId must be returned");

			const row = db.raw
				.prepare("SELECT source_id, url, doc_type FROM documents WHERE id = ?")
				.get(doc?.documentId) as unknown as
				| { source_id: number; url: string; doc_type: string }
				| undefined;
			assert.ok(row, "the document row must actually be persisted");
			assert.equal(row?.url, url);
			assert.equal(row?.doc_type, "news_article");
			assert.equal(row?.source_id, ctx.sourceId);

			// db.latestDocument is what a later run's conditional-GET path (etag /
			// last-modified reuse) relies on to find this document again.
			assert.equal(
				db.latestDocument(url)?.id,
				doc?.documentId,
				"the document must be readable back as the latest for its url",
			);
		},
	);
});

test("fetchDocument stripVolatile", async (t) => {
	// Documents are content-addressed. A source that mints a fresh CSRF token
	// or a live build timestamp in otherwise identical markup therefore hashes
	// differently on every run, minting a document row and a raw-archive file
	// each time. The CIF-SS widget does exactly that, once per sport.
	const def: ScraperDef = {
		key: "strip-test",
		name: "strip test",
		baseUrl: "https://strip.example",
		method: "html",
		run: async () => {},
	};

	await t.test(
		"a volatile page dedupes once the noise is stripped",
		async () => {
			const db = openDb(dbPath);
			const { ctx } = buildContext(db, def);
			let token = "AAAA";
			const original = globalThis.fetch;
			globalThis.fetch = (async (input: string | URL) => {
				const url = String(input);
				if (url.endsWith("/robots.txt")) return new Response(ALLOW_ALL);
				return new Response(
					`<p>same</p><input name="_token" value="${token}">`,
				);
			}) as typeof globalThis.fetch;
			try {
				const strip = (body: Buffer): Buffer =>
					Buffer.from(
						body.toString("utf8").replace(/value="[^"]*"/, 'value="X"'),
						"utf8",
					);
				const first = await ctx.fetchDocument("https://strip.example/a", {
					docType: "listing",
					stripVolatile: strip,
				});
				token = "BBBB";
				const second = await ctx.fetchDocument("https://strip.example/a", {
					docType: "listing",
					stripVolatile: strip,
				});
				assert.equal(
					second.documentId,
					first.documentId,
					"the same page must not mint a second document row",
				);
				assert.equal(ctx.counts.documentsNew, 1);
				// The archive stores what was hashed, so the two can never describe
				// different things.
				assert.doesNotMatch(second.body.toString("utf8"), /AAAA|BBBB/);
			} finally {
				globalThis.fetch = original;
				db.raw.close();
			}
		},
	);

	await t.test("without the hook the same page churns", async () => {
		// The behaviour the hook exists to change, asserted so the hook cannot
		// be quietly removed.
		const db = openDb(dbPath);
		const { ctx } = buildContext(db, { ...def, key: "churn-test" });
		let token = "CCCC";
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/robots.txt")) return new Response(ALLOW_ALL);
			return new Response(`<p>same</p><input name="_token" value="${token}">`);
		}) as typeof globalThis.fetch;
		try {
			const first = await ctx.fetchDocument("https://churn.example/a", {
				docType: "listing",
			});
			token = "DDDD";
			const second = await ctx.fetchDocument("https://churn.example/a", {
				docType: "listing",
			});
			assert.notEqual(second.documentId, first.documentId);
			assert.equal(ctx.counts.documentsNew, 2);
		} finally {
			globalThis.fetch = original;
			db.raw.close();
		}
	});
});
