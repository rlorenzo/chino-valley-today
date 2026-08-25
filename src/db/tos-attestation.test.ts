import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Db, openDb } from "./index.ts";

// Clearing a ToS hold, in its two strengths, and the lease that stops the
// short one from becoming the only review a source ever gets.

const SOURCE = "champion-news";
const V0 = "a".repeat(64);
const V1 = "b".repeat(64);
const V2 = "c".repeat(64);

function heldAt(hash: string): Db {
	const db = openDb(":memory:");
	db.setSourceTosHold(SOURCE, {
		reason: "terms_hash_drift",
		observedHash: hash,
		checkedAt: "2026-08-24T00:00:00.000Z",
	});
	return db;
}

function attestations(db: Db) {
	return db.raw
		.prepare(
			"SELECT kind, from_hash, to_hash, anchor_hash, evidence FROM tos_attestations WHERE source_key = ? ORDER BY id",
		)
		.all(SOURCE) as Array<Record<string, string>>;
}

describe("attestation", () => {
	test("seeding anchors every row from its reviewed constant", () => {
		// reviewed_hash is a human-approved baseline — a constant in tos-config
		// with a reviewer and a date beside it — so a row that predates these
		// columns is anchored to it rather than left unusable. The lease starts
		// from the day it was actually read, not from whenever the migration ran.
		const db = openDb(":memory:");
		const status = db.getSourceTosStatus(SOURCE);
		assert.equal(status.anchorHash, status.reviewedHash);
		assert.match(status.lastRebaselinedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
		assert.equal(status.attestCount, 0);
	});

	test("refuses when there is no anchor at all", () => {
		// There is no version to compare against, and a short-form clearance
		// against nothing is not a clearance.
		const db = heldAt(V1);
		db.raw
			.prepare(
				"UPDATE source_tos_status SET anchor_hash = NULL WHERE source_key = ?",
			)
			.run(SOURCE);
		assert.throws(
			() =>
				db.attestSourceTos(SOURCE, {
					observedHash: V1,
					evidence: "volatile only",
					maxAttestations: 8,
					leaseDays: 90,
				}),
			/no anchor version recorded/,
		);
	});

	test("re-baselining anchors the version and re-enables the source", () => {
		const db = heldAt(V0);
		db.rebaselineSourceTos(SOURCE, {
			observedHash: V0,
			evidence: "operator read the terms",
			attestedAt: "2026-08-24T00:00:00.000Z",
		});

		const status = db.getSourceTosStatus(SOURCE);
		assert.equal(status.status, "enabled");
		assert.equal(status.heldReason, null);
		assert.equal(status.anchorHash, V0);
		assert.equal(status.reviewedHash, V0);
		assert.equal(status.attestCount, 0);
		assert.equal(status.lastRebaselinedAt, "2026-08-24T00:00:00.000Z");
	});

	test("attesting advances the baseline but never the anchor", () => {
		// The anchor is what drift is measured from. If attesting moved it, a
		// slow migration would pass one indistinguishable step at a time.
		const db = heldAt(V0);
		db.rebaselineSourceTos(SOURCE, {
			observedHash: V0,
			evidence: "read",
			attestedAt: "2026-08-24T00:00:00.000Z",
		});
		db.setSourceTosHold(SOURCE, {
			reason: "terms_hash_drift",
			observedHash: V1,
			checkedAt: "2026-08-31T00:00:00.000Z",
		});
		db.attestSourceTos(SOURCE, {
			observedHash: V1,
			evidence: "only the widget region differs",
			attestedAt: "2026-08-31T00:00:00.000Z",
			maxAttestations: 8,
			leaseDays: 90,
		});

		const status = db.getSourceTosStatus(SOURCE);
		assert.equal(status.status, "enabled");
		assert.equal(
			status.reviewedHash,
			V1,
			"the weekly check compares to V1 now",
		);
		assert.equal(status.anchorHash, V0, "but drift is still measured from V0");
		assert.equal(status.attestCount, 1);
	});

	test("the lease runs out by count, and re-baselining resets it", () => {
		const db = heldAt(V0);
		db.rebaselineSourceTos(SOURCE, {
			observedHash: V0,
			evidence: "read",
			attestedAt: "2026-08-24T00:00:00.000Z",
		});
		for (let i = 0; i < 3; i++) {
			db.attestSourceTos(SOURCE, {
				observedHash: V1,
				evidence: "widget churn",
				attestedAt: "2026-08-31T00:00:00.000Z",
				maxAttestations: 3,
				leaseDays: 90,
			});
		}
		assert.throws(
			() =>
				db.attestSourceTos(SOURCE, {
					observedHash: V2,
					evidence: "widget churn",
					attestedAt: "2026-08-31T00:00:00.000Z",
					maxAttestations: 3,
					leaseDays: 90,
				}),
			/3 consecutive attestations/,
		);

		db.rebaselineSourceTos(SOURCE, {
			observedHash: V2,
			evidence: "read again",
			attestedAt: "2026-09-01T00:00:00.000Z",
		});
		assert.equal(db.getSourceTosStatus(SOURCE).attestCount, 0);
	});

	test("an anchor with no lease start refuses rather than skipping the check", () => {
		// `if (leaseStart)` would have skipped the day limit for exactly the rows
		// that never went through a clearance path.
		const db = heldAt(V0);
		db.raw
			.prepare(
				"UPDATE source_tos_status SET anchor_hash = ?, last_rebaselined_at = NULL WHERE source_key = ?",
			)
			.run(V0, SOURCE);
		assert.throws(
			() =>
				db.attestSourceTos(SOURCE, {
					observedHash: V1,
					evidence: "widget churn",
					attestedAt: "2026-08-25T00:00:00.000Z",
					maxAttestations: 8,
					leaseDays: 90,
				}),
			/no record of when the terms were last read/,
		);
	});

	test("the lease also runs out by elapsed time", () => {
		// A quiet source could otherwise go years on seven attestations.
		const db = heldAt(V0);
		db.rebaselineSourceTos(SOURCE, {
			observedHash: V0,
			evidence: "read",
			attestedAt: "2026-01-01T00:00:00.000Z",
		});
		assert.throws(
			() =>
				db.attestSourceTos(SOURCE, {
					observedHash: V1,
					evidence: "widget churn",
					attestedAt: "2026-08-24T00:00:00.000Z",
					maxAttestations: 8,
					leaseDays: 90,
				}),
			/last read in full \d+ days ago/,
		);
	});

	test("every clearance records what it rested on", () => {
		// A clearance with no record of its basis is indistinguishable from
		// someone silencing an alarm.
		const db = heldAt(V0);
		db.rebaselineSourceTos(SOURCE, {
			observedHash: V0,
			evidence: "operator read the terms",
			attestedAt: "2026-08-24T00:00:00.000Z",
		});
		db.attestSourceTos(SOURCE, {
			observedHash: V1,
			evidence: "only [id^=tncms-region] differs",
			attestedAt: "2026-08-31T00:00:00.000Z",
			maxAttestations: 8,
			leaseDays: 90,
		});

		const rows = attestations(db);
		assert.deepEqual(
			rows.map((r) => r.kind),
			["rebaseline", "attest"],
		);
		assert.equal(rows[1].from_hash, V0);
		assert.equal(rows[1].to_hash, V1);
		assert.equal(rows[1].anchor_hash, V0);
		assert.match(rows[1].evidence, /tncms-region/);
	});
});

describe("lease guards fail closed", () => {
	test("an unreadable last_rebaselined_at expires the lease rather than passing it", () => {
		// `NaN > leaseDays` is false, so a bare comparison would quietly switch
		// the day limit off for this source while the count limit kept working.
		const db = heldAt(V0);
		db.rebaselineSourceTos(SOURCE, {
			observedHash: V0,
			evidence: "read",
			attestedAt: "2026-08-24T00:00:00.000Z",
		});
		db.raw
			.prepare(
				"UPDATE source_tos_status SET last_rebaselined_at = 'not a date' WHERE source_key = ?",
			)
			.run(SOURCE);

		assert.throws(
			() =>
				db.attestSourceTos(SOURCE, {
					observedHash: V1,
					evidence: "widget churn",
					attestedAt: "2026-08-25T00:00:00.000Z",
					maxAttestations: 8,
					leaseDays: 90,
				}),
			/not a readable date/,
		);
	});

	test("a refused attestation leaves no attestation record behind", () => {
		// The record and the state are written together, so a clearance that did
		// not happen must not appear to have happened.
		const db = heldAt(V0);
		db.rebaselineSourceTos(SOURCE, {
			observedHash: V0,
			evidence: "read",
			attestedAt: "2026-08-24T00:00:00.000Z",
		});
		assert.throws(() =>
			db.attestSourceTos(SOURCE, {
				observedHash: V1,
				evidence: "widget churn",
				attestedAt: "2026-08-25T00:00:00.000Z",
				maxAttestations: 0,
				leaseDays: 90,
			}),
		);
		assert.deepEqual(
			attestations(db).map((r) => r.kind),
			["rebaseline"],
		);
		assert.equal(db.getSourceTosStatus(SOURCE).attestCount, 0);
	});
});
