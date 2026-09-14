// The retry budget: chat() must stop retrying while there is still time left
// in the caller's window, instead of starting an attempt that is certain to be
// killed. Before this existed, the judge's four attempts at 15 minutes each
// added up to an hour inside a systemd unit that allows 30 minutes, so the
// first retry could never finish — it only guaranteed a SIGTERM mid-attempt.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

let server: Server;
let requests = 0;

before(async () => {
	// Accepts the connection and never answers, so every attempt ends at its
	// own timeout rather than on a response.
	server = createServer((_req, _res) => {
		requests++;
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as { port: number };
	process.env.LLM_ENDPOINT = `http://127.0.0.1:${port}/v1`;
	process.env.DO_INFERENCE_API_KEY = "test-key";
});

after(() => server.close());

describe("chat retry budget", () => {
	test("gives up inside the budget instead of starting a doomed attempt", async () => {
		const { chat } = await import("./client.ts");
		requests = 0;
		const startedAt = Date.now();
		await assert.rejects(
			chat("judge", [{ role: "user", content: "hi" }], {
				timeoutMs: 300,
				budgetMs: 1_000,
			}),
		);
		const elapsed = Date.now() - startedAt;
		// One attempt, then the 15s backoff plus another 300ms attempt cannot
		// fit in the 1s budget, so it throws rather than sleeping into the wall.
		assert.equal(requests, 1);
		assert.ok(
			elapsed < 5_000,
			`should fail fast once out of budget, took ${elapsed}ms`,
		);
	});

	test("bounds the first attempt too when the budget is under the timeout", async () => {
		const { chat } = await import("./client.ts");
		requests = 0;
		const startedAt = Date.now();
		// The budget, not the 30s per-attempt timeout, has to end this attempt.
		await assert.rejects(
			chat("judge", [{ role: "user", content: "hi" }], {
				timeoutMs: 30_000,
				budgetMs: 400,
			}),
		);
		const elapsed = Date.now() - startedAt;
		assert.equal(requests, 1);
		assert.ok(
			elapsed < 5_000,
			`budget should cap the attempt, took ${elapsed}ms`,
		);
	});

	test("an unparseable CVT_LLM_BUDGET_MS falls back instead of disabling the budget", async () => {
		const { budgetFromEnv } = await import("./client.ts");
		const previous = process.env.CVT_LLM_BUDGET_MS;
		const withEnv = (v: string | undefined) => {
			if (v === undefined) delete process.env.CVT_LLM_BUDGET_MS;
			else process.env.CVT_LLM_BUDGET_MS = v;
			return budgetFromEnv();
		};
		try {
			assert.equal(withEnv(undefined), 600_000);
			assert.equal(withEnv("1234"), 1234);
			// Number("10m") is NaN, and every budget comparison against NaN is
			// false — silently restoring the unbounded retries the budget exists
			// to prevent.
			assert.equal(withEnv("10m"), 600_000);
			assert.equal(withEnv(""), 600_000);
			assert.equal(withEnv("0"), 600_000);
			assert.equal(withEnv("-5"), 600_000);
		} finally {
			withEnv(previous);
		}
	});
});
