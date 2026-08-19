import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SOURCE_TOS_REGISTRY } from "../gates/tos-config.ts";
import { type Db, openDb } from "./index.ts";

// getSourceTosStatus fails closed: anything unreviewed must read back as
// held, never as enabled. openDb() seeds a row for every SOURCE_TOS_REGISTRY
// entry, so these tests reach past that seeding (via a bare source_key that's
// never been through openDb's loop, or direct SQL) to exercise the read path
// on its own.

function freshDb(): Db {
	return openDb(":memory:");
}

// SOURCE_TOS_REGISTRY only has champion-news and dailybulletin-news today;
// asserting that here means these tests fail loudly instead of silently
// passing if a third entry is ever added.
const [registeredKey, otherRegisteredKey] = Object.keys(SOURCE_TOS_REGISTRY);

describe("getSourceTosStatus fails closed", () => {
	test("a registered source with no row is held as unreviewed_source", () => {
		const db = freshDb();
		// Simulate a registry entry that predates openDb's seeding loop having run
		// for it, by deleting the row openDb already inserted.
		db.raw
			.prepare("DELETE FROM source_tos_status WHERE source_key = ?")
			.run(registeredKey);

		const status = db.getSourceTosStatus(registeredKey);
		assert.deepEqual(status, {
			status: "held",
			heldReason: "unreviewed_source",
			reviewedHash: "",
		});
	});

	test("a source_key absent from the baseline registry is held as unreviewed_source, even with a row", () => {
		const db = freshDb();
		// A civic/agency source: never in SOURCE_TOS_REGISTRY, so openDb never
		// seeded a source_tos_status row for it, and it has no publisher terms to
		// track. Insert a row directly to prove registry membership — not row
		// presence — gates the result.
		db.raw
			.prepare(
				"INSERT INTO sources (key, name, base_url, method) VALUES (?, ?, ?, ?)",
			)
			.run("chino-legistar", "chino-legistar", "https://example.test", "html");
		db.raw
			.prepare(
				`INSERT INTO source_tos_status (source_key, status, reviewed_hash, held_reason)
				 VALUES ('chino-legistar', 'enabled', 'some-hash', NULL)`,
			)
			.run();

		const status = db.getSourceTosStatus("chino-legistar");
		assert.deepEqual(status, {
			status: "held",
			heldReason: "unreviewed_source",
			reviewedHash: "",
		});
	});

	test("a registered, seeded source reads back enabled", () => {
		const db = freshDb();
		assert.equal(SOURCE_TOS_REGISTRY[registeredKey]?.status, "enabled");

		const status = db.getSourceTosStatus(registeredKey);
		assert.equal(status.status, "enabled");
		assert.equal(status.heldReason, null);
		assert.equal(
			status.reviewedHash,
			SOURCE_TOS_REGISTRY[registeredKey]?.reviewed_hash,
		);
	});

	test("a registered source explicitly held keeps its own heldReason, not unreviewed_source", () => {
		const db = freshDb();
		db.setSourceTosHold(otherRegisteredKey, { reason: "terms_hash_drift" });

		const status = db.getSourceTosStatus(otherRegisteredKey);
		assert.equal(status.status, "held");
		assert.equal(
			status.heldReason,
			"terms_hash_drift",
			"the row's own held_reason must survive, not be overwritten by unreviewed_source",
		);
	});
});
