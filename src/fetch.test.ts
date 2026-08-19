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

/** Replaces global fetch with a URL -> response table for the duration of `fn`. */
async function withStubbedFetch(
	routes: Record<string, StubRoute>,
	fn: () => Promise<void>,
): Promise<string[]> {
	const requested: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		requested.push(url);
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
