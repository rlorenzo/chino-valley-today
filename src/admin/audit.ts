// Deterministic weekly audit sampling (PLAN.md Gate 3 / EDITORIAL.md Audit).
// Sample membership is a hash of slug+ISO-week, so it is stable for the
// whole week (repeated dashboard loads show the same sample, and the same
// post is/isn't sampled consistently) without persisting a sample list
// anywhere — recomputed on every page load from the posts table.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";

// Midpoint of PLAN's "10-15%" band.
export const AUDIT_RATE = 0.12;

function mondayUtc(d: Date): Date {
	const date = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
	);
	const dayNum = date.getUTCDay() || 7; // Mon=1 .. Sun=7
	date.setUTCDate(date.getUTCDate() - dayNum + 1);
	return date;
}

// Standard ISO-8601 week: the week containing the year's first Thursday is
// week 1; a year's week number is taken from the Thursday of that week.
export function isoWeekString(d: Date = new Date()): string {
	const date = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
	);
	const dayNum = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - dayNum); // nearest Thursday
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(
		((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
	);
	return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function currentWeekStartIso(d: Date = new Date()): string {
	return mondayUtc(d).toISOString();
}

// Stable pseudo-random fraction in [0,1) derived from sha256(slug:isoWeek).
// Deterministic and close enough to uniform for a review-sampling gate;
// no seeded-PRNG dependency needed.
export function sampleFraction(slug: string, isoWeek: string): number {
	const h = createHash("sha256").update(`${slug}:${isoWeek}`).digest();
	return h.readUInt32BE(0) / 0x1_0000_0000;
}

export function isSampledForAudit(
	slug: string,
	isoWeek: string,
	rate: number = AUDIT_RATE,
): boolean {
	return sampleFraction(slug, isoWeek) < rate;
}

// Rolling N-day count of 'fail' audit verdicts per post_type — the
// demote-to-held-by-default signal (PLAN.md Gate 3: "two substantive misses
// in a rolling month = tighten gates or demote the post type").
export function rollingFailCounts(
	db: Db,
	days: number = 30,
): Map<string, number> {
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
	const rows = db.raw
		.prepare(
			`SELECT p.post_type as post_type, COUNT(*) as cnt
       FROM audit_log a JOIN posts p ON a.post_id = p.id
       WHERE a.verdict = 'fail' AND a.audited_at >= ?
       GROUP BY p.post_type`,
		)
		.all(cutoff) as Array<{ post_type: string; cnt: number }>;
	const m = new Map<string, number>();
	for (const r of rows) m.set(r.post_type, r.cnt);
	return m;
}
