import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { openDb } from "../src/db/index.ts";
import type { RawResult } from "../src/fetch.ts";
import { SOURCE_TOS_REGISTRY } from "../src/gates/tos-config.ts";
import {
	checkSingleSourceTos,
	resetSingleSourceTos,
} from "./check-tos-drift.ts";

let tmpDir: string;
let dbPath: string;

before(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cvt-tos-test-"));
	dbPath = join(tmpDir, "test.db");
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

test("check-tos-drift watchdog and reset suite", async (t) => {
	const db = openDb(dbPath);
	const targetSource = "champion-news";
	const config = SOURCE_TOS_REGISTRY[targetSource];

	// Create a mock fetcher that returns exact reviewed hash content
	const matchingBody = Buffer.from(
		"Baseline Terms of Service content for test",
	);
	const matchingHash = createHash("sha256").update(matchingBody).digest("hex");

	// Temporarily override reviewed_hash on config for deterministic unit
	// testing. SOURCE_TOS_REGISTRY is module state shared with every other
	// test in this file, so the restore is registered with the runner rather
	// than written at the bottom of the suite: a failing assertion would skip
	// a trailing restore and leave the registry mutated for whatever ran next.
	const originalReviewedHash = config.reviewed_hash;
	(config as { reviewed_hash: string }).reviewed_hash = matchingHash;
	t.after(() => {
		(config as { reviewed_hash: string }).reviewed_hash = originalReviewedHash;
	});

	// Reset db row to match
	db.raw
		.prepare(
			"UPDATE source_tos_status SET reviewed_hash = ?, status = 'enabled', held_reason = NULL WHERE source_key = ?",
		)
		.run(matchingHash, targetSource);

	const createMockFetcher = (result: Partial<RawResult>, throws?: Error) => {
		return async (): Promise<RawResult> => {
			if (throws) throw throws;
			return {
				status: result.status ?? 200,
				ok: result.ok ?? true,
				notModified: false,
				body: result.body ?? matchingBody,
				etag: null,
				lastModified: null,
				contentType: "text/html",
				finalUrl: config.terms_url,
			};
		};
	};

	await t.test("matching terms hash maintains enabled status", async () => {
		const fetcher = createMockFetcher({ body: matchingBody });
		const res = await checkSingleSourceTos(targetSource, {
			db,
			fetcher,
			now: "2026-08-18T12:00:00.000Z",
		});

		assert.equal(res.ok, true);
		assert.equal(res.status, "enabled");
		assert.equal(res.hash, matchingHash);

		const inDb = db.getSourceTosStatus(targetSource);
		assert.equal(inDb.status, "enabled");
		assert.equal(inDb.lastObservedHash, matchingHash);
		assert.equal(inDb.lastCheckedAt, "2026-08-18T12:00:00.000Z");
	});

	await t.test("drifted terms hash sets status to held", async () => {
		const modifiedBody = Buffer.from("New Modified Terms of Service Body 2026");
		const modifiedHash = createHash("sha256")
			.update(modifiedBody)
			.digest("hex");
		const fetcher = createMockFetcher({ body: modifiedBody });

		const res = await checkSingleSourceTos(targetSource, {
			db,
			fetcher,
			now: "2026-08-18T13:00:00.000Z",
		});

		assert.equal(res.ok, false);
		assert.equal(res.status, "held");
		assert.equal(res.reason, "terms_hash_drift");
		assert.equal(res.hash, modifiedHash);

		const inDb = db.getSourceTosStatus(targetSource);
		assert.equal(inDb.status, "held");
		assert.equal(inDb.heldReason, "terms_hash_drift");
		assert.equal(inDb.lastObservedHash, modifiedHash);
	});

	await t.test(
		"routine probe on held source preserves held status",
		async () => {
			// Even if the probe now sees the matching hash, a routine check does NOT auto-enable
			const fetcher = createMockFetcher({ body: matchingBody });
			const res = await checkSingleSourceTos(targetSource, {
				db,
				fetcher,
				now: "2026-08-18T14:00:00.000Z",
			});

			assert.equal(res.ok, false);
			assert.equal(res.status, "held");
			assert.equal(res.reason, "terms_hash_drift");

			const inDb = db.getSourceTosStatus(targetSource);
			assert.equal(inDb.status, "held");
		},
	);

	await t.test("fetch error / HTTP 500 sets status to held", async () => {
		const fetcher = createMockFetcher({ status: 500, ok: false });
		const res = await checkSingleSourceTos(targetSource, {
			db,
			fetcher,
			now: "2026-08-18T15:00:00.000Z",
		});

		assert.equal(res.ok, false);
		assert.equal(res.status, "held");
		assert.match(res.reason ?? "", /fetch_error/);

		const inDb = db.getSourceTosStatus(targetSource);
		assert.equal(inDb.status, "held");
		assert.match(inDb.heldReason ?? "", /fetch_error/);
	});

	await t.test(
		"operator reset workflow clears hold when hash matches",
		async () => {
			const fetcher = createMockFetcher({ body: matchingBody });
			const res = await resetSingleSourceTos(targetSource, {
				db,
				fetcher,
				now: "2026-08-18T16:00:00.000Z",
			});

			assert.equal(res.ok, true);
			assert.equal(res.hash, matchingHash);

			const inDb = db.getSourceTosStatus(targetSource);
			assert.equal(inDb.status, "enabled");
			assert.equal(inDb.heldReason, null);
			assert.equal(inDb.lastObservedHash, matchingHash);
		},
	);

	// The publisher-updated-their-terms path end to end: drift holds the source,
	// the operator re-reviews and updates the baseline in tos-config, and the
	// reset has to re-baseline the row. If the reset left the old reviewed hash
	// in the row, the next weekly check would read the operator's own approved
	// hash as drift and put the source straight back on hold.
	await t.test("operator reset re-baselines the reviewed hash", async () => {
		const updatedBody = Buffer.from("Publisher revised the Terms of Service");
		const updatedHash = createHash("sha256").update(updatedBody).digest("hex");
		const fetcher = createMockFetcher({ body: updatedBody });

		await checkSingleSourceTos(targetSource, {
			db,
			fetcher,
			now: "2026-08-18T17:00:00.000Z",
		});
		assert.equal(db.getSourceTosStatus(targetSource).status, "held");

		// Operator reviews the new terms and updates the baseline contract.
		(config as { reviewed_hash: string }).reviewed_hash = updatedHash;
		await resetSingleSourceTos(targetSource, {
			db,
			fetcher,
			now: "2026-08-18T18:00:00.000Z",
		});
		assert.equal(db.getSourceTosStatus(targetSource).reviewedHash, updatedHash);

		// Next scheduled check sees no drift and leaves the source enabled.
		await checkSingleSourceTos(targetSource, {
			db,
			fetcher,
			now: "2026-08-25T12:00:00.000Z",
		});
		assert.equal(db.getSourceTosStatus(targetSource).status, "enabled");

		// Restore the fixture baseline for the tests that follow.
		(config as { reviewed_hash: string }).reviewed_hash = matchingHash;
		await resetSingleSourceTos(targetSource, {
			db,
			fetcher: createMockFetcher({ body: matchingBody }),
			now: "2026-08-25T13:00:00.000Z",
		});
	});

	await t.test(
		"operator reset workflow refuses when hash does not match",
		async () => {
			const mismatchedBody = Buffer.from("Still Mismatched Content");
			const fetcher = createMockFetcher({ body: mismatchedBody });

			await assert.rejects(
				async () => {
					await resetSingleSourceTos(targetSource, { db, fetcher });
				},
				{
					message: /observed hash .* does not match baseline reviewed hash/,
				},
			);

			const inDb = db.getSourceTosStatus(targetSource);
			assert.equal(inDb.status, "enabled"); // from previous test
		},
	);
});
