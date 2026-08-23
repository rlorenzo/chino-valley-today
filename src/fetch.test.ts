import assert from "node:assert/strict";
import test from "node:test";
import { politeFetch } from "./fetch.ts";

// politeFetch caches robots.txt per origin for the life of the process, so every
// test below uses its own hostname. That also keeps the 2s per-host politeness
// delay out of the way: the first request to a host never waits.

interface StubRoute {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
	throws?: Error;
}

/**
 * The (url, init) of every stubbed request, for assertions about the request
 * itself — verb, headers, body. Reset by each `withStubbedFetch` call.
 */
let calls: { url: string; init: RequestInit }[] = [];

/** Replaces global fetch with a URL -> response table for the duration of `fn`. */
async function withStubbedFetch(
	routes: Record<string, StubRoute>,
	fn: () => Promise<void>,
): Promise<string[]> {
	const requested: string[] = [];
	calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		const url = String(input);
		requested.push(url);
		calls.push({ url, init });
		const route = routes[url];
		if (!route) return new Response("not found", { status: 404 });
		if (route.throws) throw route.throws;
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
	return requested;
}

const ALLOW_ALL = "User-agent: *\nAllow: /\n";

test("politeFetch host and protocol allowlisting", async (t) => {
	await t.test("rejects a host outside allowedHosts", async () => {
		await assert.rejects(
			() =>
				politeFetch("https://evil.example/news", {
					allowedHosts: ["good.example"],
				}),
			{ message: /Host not allowed: evil\.example/ },
		);
	});

	await t.test("rejects http when an allowlist is in force", async () => {
		await assert.rejects(
			() =>
				politeFetch("http://good.example/news", {
					allowedHosts: ["good.example"],
				}),
			{ message: /Insecure protocol rejected: http:/ },
		);
	});
});

test("politeFetch manual redirect handling", async (t) => {
	// The bare -> www hop these publishers all perform, which is why both spellings
	// sit in every scraper's allowedHosts.
	await t.test(
		"follows in-allowlist redirects and reports finalUrl",
		async () => {
			let res: Awaited<ReturnType<typeof politeFetch>> | undefined;
			await withStubbedFetch(
				{
					"https://hop1.example/robots.txt": { body: ALLOW_ALL },
					"https://www.hop1.example/robots.txt": { body: ALLOW_ALL },
					"https://hop1.example/a": {
						status: 301,
						headers: { location: "https://www.hop1.example/a" },
					},
					"https://www.hop1.example/a": { body: "final body" },
				},
				async () => {
					res = await politeFetch("https://hop1.example/a", {
						manualRedirect: true,
						allowedHosts: ["hop1.example", "www.hop1.example"],
						maxRedirectHops: 3,
					});
				},
			);

			assert.equal(res?.ok, true);
			assert.equal(res?.finalUrl, "https://www.hop1.example/a");
			assert.equal(res?.body.toString("utf8"), "final body");
		},
	);

	await t.test("refuses a redirect that leaves the allowlist", async () => {
		await withStubbedFetch(
			{
				"https://hop2.example/robots.txt": { body: ALLOW_ALL },
				"https://hop2.example/a": {
					status: 302,
					headers: { location: "https://elsewhere.example/a" },
				},
			},
			async () => {
				await assert.rejects(
					() =>
						politeFetch("https://hop2.example/a", {
							manualRedirect: true,
							allowedHosts: ["hop2.example"],
						}),
					{ message: /Host not allowed: elsewhere\.example/ },
				);
			},
		);
	});

	await t.test("gives up once maxRedirectHops is exceeded", async () => {
		await withStubbedFetch(
			{
				"https://hop3.example/robots.txt": { body: ALLOW_ALL },
				"https://one.hop3.example/robots.txt": { body: ALLOW_ALL },
				"https://hop3.example/a": {
					status: 302,
					headers: { location: "https://one.hop3.example/b" },
				},
				"https://one.hop3.example/b": {
					status: 302,
					headers: { location: "https://two.hop3.example/c" },
				},
			},
			async () => {
				await assert.rejects(
					() =>
						politeFetch("https://hop3.example/a", {
							manualRedirect: true,
							allowedHosts: [
								"hop3.example",
								"one.hop3.example",
								"two.hop3.example",
							],
							maxRedirectHops: 1,
						}),
					{ message: /Exceeded max redirect hops \(1\)/ },
				);
			},
		);
	});

	await t.test("refuses a redirect with no Location header", async () => {
		await withStubbedFetch(
			{
				"https://hop4.example/robots.txt": { body: ALLOW_ALL },
				"https://hop4.example/a": { status: 301 },
			},
			async () => {
				await assert.rejects(
					() =>
						politeFetch("https://hop4.example/a", {
							manualRedirect: true,
							allowedHosts: ["hop4.example"],
						}),
					{ message: /Redirect HTTP 301 without Location header/ },
				);
			},
		);
	});
});

test("politeFetch fail-closed robots", async (t) => {
	await t.test("throws when robots.txt is unreachable", async () => {
		await withStubbedFetch(
			{
				"https://closed1.example/robots.txt": {
					throws: new Error("ECONNREFUSED"),
				},
				"https://closed1.example/a": { body: "should never be read" },
			},
			async () => {
				await assert.rejects(
					() =>
						politeFetch("https://closed1.example/a", {
							failClosedRobots: true,
						}),
					{ message: /robots\.txt check failed \(fail-closed\)/ },
				);
			},
		);
	});

	await t.test("throws when robots.txt answers non-2xx", async () => {
		await withStubbedFetch(
			{
				"https://closed2.example/robots.txt": { status: 503 },
				"https://closed2.example/a": { body: "should never be read" },
			},
			async () => {
				await assert.rejects(
					() =>
						politeFetch("https://closed2.example/a", {
							failClosedRobots: true,
						}),
					{ message: /robots\.txt check failed \(fail-closed, HTTP 503\)/ },
				);
			},
		);
	});

	await t.test("proceeds when robots.txt allows the path", async () => {
		let res: Awaited<ReturnType<typeof politeFetch>> | undefined;
		await withStubbedFetch(
			{
				"https://closed3.example/robots.txt": { body: ALLOW_ALL },
				"https://closed3.example/a": { body: "allowed" },
			},
			async () => {
				res = await politeFetch("https://closed3.example/a", {
					failClosedRobots: true,
				});
			},
		);
		assert.equal(res?.body.toString("utf8"), "allowed");
	});

	await t.test("honours a Disallow even under fail-closed", async () => {
		await withStubbedFetch(
			{
				"https://closed4.example/robots.txt": {
					body: "User-agent: *\nDisallow: /private\n",
				},
			},
			async () => {
				await assert.rejects(
					() =>
						politeFetch("https://closed4.example/private/a", {
							failClosedRobots: true,
						}),
					{ message: /robots\.txt disallows/ },
				);
			},
		);
	});
});

test("politeFetch jsonBody sends a POST", async (t) => {
	/** The init of the request to `url`; an empty init if it was never made. */
	const initFor = (url: string): RequestInit =>
		calls.find((c) => c.url === url)?.init ?? {};
	const headersOf = (init: RequestInit) =>
		(init.headers ?? {}) as Record<string, string>;

	await t.test("serialises the body and declares its type", async () => {
		await withStubbedFetch(
			{
				"https://post1.example/robots.txt": { body: ALLOW_ALL },
				"https://post1.example/api": { body: "{}" },
			},
			async () => {
				await politeFetch("https://post1.example/api", {
					jsonBody: { school_id: "103" },
				});
			},
		);
		const init = initFor("https://post1.example/api");
		assert.equal(init.method, "POST");
		assert.equal(init.body, '{"school_id":"103"}');
		assert.equal(headersOf(init)["content-type"], "application/json");
	});

	await t.test(
		"drops the conditional headers a POST cannot answer",
		async () => {
			// if-none-match on a POST asks about a cached representation the verb
			// does not have, and some servers reject it outright.
			await withStubbedFetch(
				{
					"https://post2.example/robots.txt": { body: ALLOW_ALL },
					"https://post2.example/api": { body: "{}" },
				},
				async () => {
					await politeFetch("https://post2.example/api", {
						jsonBody: {},
						etag: 'W/"abc"',
						lastModified: "Wed, 19 Aug 2026 00:00:00 GMT",
					});
				},
			);
			const headers = headersOf(initFor("https://post2.example/api"));
			assert.equal(headers["if-none-match"], undefined);
			assert.equal(headers["if-modified-since"], undefined);
		},
	);

	await t.test(
		"still sends them on a GET, and still identifies us",
		async () => {
			// The politeness contract is unchanged by the verb: this guards the GET
			// half of the same branch.
			await withStubbedFetch(
				{
					"https://post3.example/robots.txt": { body: ALLOW_ALL },
					"https://post3.example/api": { body: "{}" },
				},
				async () => {
					await politeFetch("https://post3.example/api", { etag: 'W/"abc"' });
				},
			);
			const init = initFor("https://post3.example/api");
			const headers = headersOf(init);
			assert.equal(init.method, undefined);
			assert.equal(headers["if-none-match"], 'W/"abc"');
			assert.match(headers["user-agent"], /@/);
		},
	);

	await t.test(
		"refuses to follow a redirect rather than replay the body",
		async () => {
			// Copilot's finding on PR #47. Following a redirected POST means
			// rewriting the method — 303 MUST become a GET, 301/302 became one by
			// practice, only 307/308 keep the body — and replaying it can
			// duplicate a side effect. A POST endpoint that starts redirecting
			// means the API moved, which is something to notice.
			for (const status of [301, 302, 303, 307, 308]) {
				await withStubbedFetch(
					{
						[`https://redir${status}.example/robots.txt`]: { body: ALLOW_ALL },
						[`https://redir${status}.example/api`]: {
							status,
							headers: { location: `https://redir${status}.example/moved` },
						},
						[`https://redir${status}.example/moved`]: { body: "{}" },
					},
					async () => {
						await assert.rejects(
							politeFetch(`https://redir${status}.example/api`, {
								jsonBody: { a: 1 },
								manualRedirect: true,
								allowedHosts: [`redir${status}.example`],
							}),
							/Refusing to follow HTTP \d+ redirect for a POST/,
							`HTTP ${status} should be refused, not followed`,
						);
					},
				);
				assert.equal(
					calls.filter((c) => c.url.endsWith("/moved")).length,
					0,
					`HTTP ${status}: the body must never reach the redirect target`,
				);
			}
		},
	);

	await t.test(
		"inspects its own redirects even when the caller did not ask for manual mode",
		async () => {
			// The reachable half of the same defect: with redirect:"follow" the
			// runtime follows 307/308 itself, replaying the body AND skipping the
			// per-hop allow-list check above. The sports scrapers POST without
			// manualRedirect, so this is the path they actually take.
			await withStubbedFetch(
				{
					"https://autofollow.example/robots.txt": { body: ALLOW_ALL },
					"https://autofollow.example/api": {
						status: 308,
						headers: { location: "https://elsewhere.example/api" },
					},
					"https://elsewhere.example/api": { body: "{}" },
				},
				async () => {
					await assert.rejects(
						politeFetch("https://autofollow.example/api", {
							jsonBody: { a: 1 },
							allowedHosts: ["autofollow.example"],
						}),
						/Refusing to follow HTTP 308 redirect for a POST/,
					);
				},
			);
			// Exact URL, not a prefix: `startsWith` on an origin is the substring
			// check CodeQL rightly flags, since "https://elsewhere.example.evil"
			// would satisfy it.
			assert.equal(
				calls.filter((c) => c.url === "https://elsewhere.example/api").length,
				0,
				"the body must never reach an unvalidated host",
			);
		},
	);

	await t.test("still follows redirects for a GET", async () => {
		// The refusal is about the body, not about manual redirect inspection,
		// which the fail-closed press sources depend on.
		await withStubbedFetch(
			{
				"https://redirget.example/robots.txt": { body: ALLOW_ALL },
				"https://redirget.example/a": {
					status: 301,
					headers: { location: "https://redirget.example/b" },
				},
				"https://redirget.example/b": { body: "ok" },
			},
			async () => {
				const res = await politeFetch("https://redirget.example/a", {
					manualRedirect: true,
					allowedHosts: ["redirget.example"],
				});
				assert.equal(res.body.toString(), "ok");
			},
		);
	});

	await t.test(
		"an allow-list forces redirect inspection even for a plain GET",
		async () => {
			// Copilot's third finding. validateHostAndProtocol runs at the top of
			// the loop and nowhere else, so under redirect:"follow" a cross-host
			// hop escapes both the allow-list and the robots check for wherever it
			// landed — making allowedHosts advisory precisely when a source starts
			// misbehaving.
			await withStubbedFetch(
				{
					"https://locked.example/robots.txt": { body: ALLOW_ALL },
					"https://locked.example/page": {
						status: 302,
						headers: { location: "https://escaped.example/page" },
					},
					"https://escaped.example/robots.txt": { body: ALLOW_ALL },
					"https://escaped.example/page": { body: "off-limits" },
				},
				async () => {
					await assert.rejects(
						politeFetch("https://locked.example/page", {
							allowedHosts: ["locked.example"],
						}),
						/Host not allowed: escaped\.example/,
					);
				},
			);
			assert.equal(
				calls.filter((c) => c.url === "https://escaped.example/page").length,
				0,
				"a hop outside the allow-list must never be fetched",
			);
		},
	);

	await t.test(
		"a same-host redirect still resolves under an allow-list",
		async () => {
			// The tightening must not turn an ordinary http->https or trailing-slash
			// hop into a failure for the sources that pass an allow-list today.
			await withStubbedFetch(
				{
					"https://samehost.example/robots.txt": { body: ALLOW_ALL },
					"https://samehost.example/a": {
						status: 301,
						headers: { location: "https://samehost.example/b" },
					},
					"https://samehost.example/b": { body: "ok" },
				},
				async () => {
					const res = await politeFetch("https://samehost.example/a", {
						allowedHosts: ["samehost.example"],
					});
					assert.equal(res.body.toString(), "ok");
				},
			);
		},
	);

	await t.test("does not retry a POST by default", async () => {
		// A transport error cannot distinguish a request that never arrived from
		// one that arrived and whose response was lost. Replaying the second kind
		// delivers it twice, so a POST is tried once unless the caller vouches
		// for the body.
		await withStubbedFetch(
			{
				"https://noretry.example/robots.txt": { body: ALLOW_ALL },
				"https://noretry.example/api": { status: 503 },
			},
			async () => {
				const res = await politeFetch("https://noretry.example/api", {
					jsonBody: { a: 1 },
				});
				assert.equal(res.status, 503);
			},
		);
		assert.equal(
			calls.filter((c) => c.url === "https://noretry.example/api").length,
			1,
			"a POST must be attempted exactly once by default",
		);
	});

	await t.test("retries a POST the caller vouched for", async () => {
		await withStubbedFetch(
			{
				"https://retryok.example/robots.txt": { body: ALLOW_ALL },
				"https://retryok.example/api": { status: 503 },
			},
			async () => {
				await politeFetch("https://retryok.example/api", {
					jsonBody: { a: 1 },
					bodyIsIdempotent: true,
				});
			},
		);
		assert.equal(
			calls.filter((c) => c.url === "https://retryok.example/api").length,
			2,
			"an idempotent POST retries once, like a GET",
		);
	});

	await t.test("a GET still retries without any opt-in", async () => {
		await withStubbedFetch(
			{
				"https://getretry.example/robots.txt": { body: ALLOW_ALL },
				"https://getretry.example/page": { status: 500 },
			},
			async () => {
				await politeFetch("https://getretry.example/page");
			},
		);
		assert.equal(
			calls.filter((c) => c.url === "https://getretry.example/page").length,
			2,
		);
	});

	await t.test("robots still gates a POST", async () => {
		// A POST is a different verb, not a different politeness contract.
		await withStubbedFetch(
			{
				"https://post4.example/robots.txt": {
					body: "User-agent: *\nDisallow: /wp-json\n",
				},
			},
			async () => {
				await assert.rejects(
					() =>
						politeFetch("https://post4.example/wp-json/x", { jsonBody: {} }),
					{ message: /robots\.txt disallows/ },
				);
			},
		);
	});
});
