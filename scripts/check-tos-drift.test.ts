import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { openDb } from "../src/db/index.ts";
import type { RawResult } from "../src/fetch.ts";
import { SOURCE_TOS_REGISTRY } from "../src/gates/tos-config.ts";
import { findRaw, readRaw, saveRaw } from "../src/store.ts";
import { diffLines } from "../src/utils/line-diff.ts";
import {
	attestSource,
	checkSingleSourceTos,
	classifyKnownDrift,
	diffTerms,
	rebaselineSource,
	resetSingleSourceTos,
	termsLines,
} from "./check-tos-drift.ts";

let tmpDir: string;
let dbPath: string;

before(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cvt-tos-test-"));
	dbPath = join(tmpDir, "test.db");
	// Every check archives the bytes it hashes. Point that at the temp dir so
	// invented terms strings never land in the real raw archive.
	process.env.CVT_RAW_ROOT = tmpDir;
});

after(() => {
	delete process.env.CVT_RAW_ROOT;
	rmSync(tmpDir, { recursive: true, force: true });
});

test("check-tos-drift watchdog and reset suite", async (t) => {
	const db = openDb(dbPath);
	const targetSource = "champion-news";
	const config = SOURCE_TOS_REGISTRY[targetSource];

	// champion-news is the only source carrying a `scope`, so the scoped paths
	// below can use nothing else. It is also baseline-`held` now, by the terms
	// decision recorded in tos-config.ts, and resetSourceTosHold refuses a
	// source the registry declares held. The reset subtests are about the reset
	// MECHANISM, not about this outlet, so the baseline status is overridden for
	// the run and restored after — the same treatment reviewed_hash already
	// gets a few lines down, and for the same reason.
	const originalStatus = config.status;
	(config as { status: "enabled" | "held" }).status = "enabled";
	t.after(() => {
		(config as { status: "enabled" | "held" }).status = originalStatus;
	});

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

test("termsText reduces a terms page to the words a person would read", () => {
	const html = `
		<html><head><style>.x{color:red}</style>
		<script>var buildId = "9f2c1a";</script></head>
		<body><h1>Terms of Use</h1>
		<p>You may not scrape&nbsp;this site.</p>
		<div>Effective <b>1 August 2026</b>.</div></body></html>`;

	assert.deepEqual(termsLines(html, "x.html"), [
		"Terms of Use",
		"You may not scrape this site.",
		"Effective 1 August 2026 .",
	]);
});

test("a rebuilt asset id is not reported as a terms change", () => {
	// The reason the diff runs on text and not on markup. A publisher rotating
	// a build hash changes the bytes, and therefore the sha256, and therefore
	// holds the source — but it has not changed one word of the terms.
	const page = (buildId: string) =>
		`<html><script>var b="${buildId}";</script><body><p>No scraping.</p></body></html>`;

	assert.deepEqual(
		termsLines(page("aaa111"), "x.html"),
		termsLines(page("bbb222"), "x.html"),
	);
});

test("check-tos-drift archives the bytes it hashes, so a drift can be diffed", async (t) => {
	const dbPath2 = join(tmpDir, "archive.db");
	const db = openDb(dbPath2);
	const source = "champion-news";
	const config = SOURCE_TOS_REGISTRY[source];

	const v1 = Buffer.from(
		"<html><body><p>You may link to our headlines.</p></body></html>",
	);
	const v2 = Buffer.from(
		"<html><body><p>You may link to our headlines.</p><p>No AI training.</p></body></html>",
	);
	const v1Hash = createHash("sha256").update(v1).digest("hex");

	const original = config.reviewed_hash;
	(config as { reviewed_hash: string }).reviewed_hash = v1Hash;
	t.after(() => {
		(config as { reviewed_hash: string }).reviewed_hash = original;
	});
	db.raw
		.prepare(
			"UPDATE source_tos_status SET reviewed_hash = ?, status = 'enabled', held_reason = NULL WHERE source_key = ?",
		)
		.run(v1Hash, source);

	const fetcherFor = (body: Buffer) => async (): Promise<RawResult> => ({
		status: 200,
		ok: true,
		notModified: false,
		body,
		etag: null,
		lastModified: null,
		contentType: "text/html",
		finalUrl: config.terms_url,
	});

	// The reviewed version is archived by the check that sees it...
	await checkSingleSourceTos(source, { db, fetcher: fetcherFor(v1) });
	const archived = findRaw(v1Hash);
	assert.ok(archived, "the reviewed terms should be in the archive");
	assert.equal(readRaw(archived).toString(), v1.toString());

	// ...and the next week's drift is then answerable as a diff rather than as
	// "something changed, go read three websites".
	await checkSingleSourceTos(source, { db, fetcher: fetcherFor(v2) });
	assert.equal(db.getSourceTosStatus(source).status, "held");

	const diff = diffTerms(db, source);
	assert.equal(diff.ok, true);
	assert.match(diff.message, /\+ No AI training\./);
	assert.match(diff.message, /1 line\(s\) added, 0 removed/);
});

test("a drift with no archived copy says so instead of showing an empty diff", () => {
	// True of every hash reviewed before this archiving existed. An empty diff
	// would read as "nothing changed", which is the one thing it does not mean.
	const db = openDb(join(tmpDir, "unarchived.db"));
	db.raw
		.prepare(
			"UPDATE source_tos_status SET reviewed_hash = ?, last_observed_hash = ?, status = 'held', held_reason = 'terms_hash_drift' WHERE source_key = ?",
		)
		.run("a".repeat(64), "b".repeat(64), "champion-news");

	const res = diffTerms(db, "champion-news");
	assert.equal(res.ok, false);
	assert.match(res.message, /cannot diff/);
	assert.match(res.message, /exist only as hashes/);
});

test("termsText closes a script tag the way a browser does", () => {
	// "</script >" ends a script, and so does "</script\n foo>". A pattern that
	// misses either leaves the script body in the text, where a rotating build
	// id reads as a terms change.
	for (const end of ["</script>", "</script >", "</script\n foo>"]) {
		assert.deepEqual(
			termsLines(
				`<body><script>var b="x";${end}<p>No scraping.</p></body>`,
				"x.html",
			),
			["No scraping."],
			`end tag ${JSON.stringify(end)} should close the script`,
		);
	}
});

test("termsText drops an unterminated script rather than reading it as prose", () => {
	assert.deepEqual(
		termsLines("<body><p>No scraping.</p><script>var b = 1 < 2;", "x.html"),
		["No scraping."],
	);
});

test("termsText decodes entities once, not repeatedly", () => {
	// "&amp;lt;" is the literal text "&lt;". Decoding entity by entity would
	// turn it into "<" — a change to the terms that the publisher never made.
	assert.deepEqual(
		termsLines("<p>&amp;lt; and &amp;amp; stay literal</p>", "x.html"),
		["&lt; and &amp; stay literal"],
	);
});

test("a held source with nothing observed says so instead of 'no drift'", () => {
	// A first check that cannot reach the terms page holds the source without
	// recording an observed hash. Comparing nothing to the reviewed hash is not
	// agreement, so --diff must not answer "the terms match" and exit 0 at an
	// operator asking why the source is held.
	const db = openDb(join(tmpDir, "unobserved.db"));
	db.raw
		.prepare(
			"UPDATE source_tos_status SET last_observed_hash = NULL, status = 'held', held_reason = 'fetch_error: HTTP 503' WHERE source_key = ?",
		)
		.run("champion-news");

	const res = diffTerms(db, "champion-news");
	assert.equal(
		res.ok,
		false,
		"exit 0 would read as all-clear on a held source",
	);
	assert.match(res.message, /nothing to diff/);
	assert.doesNotMatch(res.message, /no drift/);
	assert.match(res.message, /status: held \(fetch_error: HTTP 503\)/);
});

test("a no-drift diff still reports that the source is held", () => {
	// An earlier hold survives a matching hash by design, so "no drift" alone
	// would leave an operator thinking the source is enabled again.
	const db = openDb(join(tmpDir, "held-but-matching.db"));
	const reviewed = db.getSourceTosStatus("champion-news").reviewedHash;
	db.raw
		.prepare(
			"UPDATE source_tos_status SET last_observed_hash = ?, status = 'held', held_reason = 'fetch_error: HTTP 503' WHERE source_key = ?",
		)
		.run(reviewed, "champion-news");

	const res = diffTerms(db, "champion-news");
	assert.equal(res.ok, true);
	assert.match(res.message, /no drift/);
	assert.match(res.message, /status: held \(fetch_error: HTTP 503\)/);
});
test("diffTerms refuses a key that is not in the registry", () => {
	// The CLI turns this into the same one-line answer --reset gives, rather
	// than a stack trace at an operator who mistyped a source name.
	assert.throws(
		() => diffTerms(openDb(join(tmpDir, "unknown.db")), "not-a-source"),
		/Unknown source key in ToS registry/,
	);
});

test("termsLines leaves a robots.txt exactly as it is", () => {
	// 7 of the 10 tracked sources point at a robots.txt, which SOURCES.md
	// records as the binding access document where a publisher has no separate
	// terms page. It is line-oriented and its BLANK LINES ARE SEMANTIC: a blank
	// line ends a user-agent group. Reducing it the way HTML is reduced drops
	// them, and "Disallow: /" moving from one bot to every crawler would then
	// diff as no change at all — on the document that governs whether we may
	// fetch the site.
	const robots =
		"User-agent: *\nDisallow: /cgi-bin/\n\nUser-agent: BadBot\nDisallow: /\n";
	assert.deepEqual(termsLines(robots, "data/raw/ab/abc.txt"), [
		"User-agent: *",
		"Disallow: /cgi-bin/",
		"",
		"User-agent: BadBot",
		"Disallow: /",
		"",
	]);
});

test("a blank line moving in a robots.txt is a change, not a no-op", () => {
	const grouped = "User-agent: BadBot\n\nDisallow: /\n";
	const merged = "User-agent: BadBot\nDisallow: /\n";
	const result = diffLines(
		termsLines(grouped, "x.txt"),
		termsLines(merged, "x.txt"),
	);
	assert.ok(
		result.added + result.removed > 0,
		"regrouping a robots.txt must not read as unchanged",
	);
});

test("termsLines normalises line endings and nothing else", () => {
	// A file that switched from CRLF to LF must not read as every line changing.
	assert.deepEqual(
		termsLines("User-agent: *\r\n\r\nDisallow: /\r\n", "x.txt"),
		termsLines("User-agent: *\n\nDisallow: /\n", "x.txt"),
	);
});

// End to end: a drift on a scoped source, classified, then cleared the short
// way — and refused when the terms themselves moved.
test("a scoped source reports which KIND of drift it is holding on", async (t) => {
	const db = openDb(join(tmpDir, "scoped.db"));
	const source = "champion-news";
	const config = SOURCE_TOS_REGISTRY[source];

	const page = (headline: string, clause: string) =>
		Buffer.from(
			`<html><body><article id="staticpage"><header><h1>Terms of Service</h1></header>` +
				`<p>These Terms of Service govern your use of ChampionNewspapers.com. ${clause}</p>` +
				`<p>${"Padding that keeps the document above the length floor. ".repeat(400)}</p>` +
				`<div id="tncms-region-global-side-primary"><ul><li>${headline}</li></ul></div>` +
				`</article></body></html>`,
		);

	const approved = page("Old story", "You may not republish the Content.");
	const approvedHash = createHash("sha256").update(approved).digest("hex");
	const original = config.reviewed_hash;
	(config as { reviewed_hash: string }).reviewed_hash = approvedHash;
	t.after(() => {
		(config as { reviewed_hash: string }).reviewed_hash = original;
	});
	db.raw
		.prepare(
			"UPDATE source_tos_status SET reviewed_hash = ?, anchor_hash = ?, status = 'enabled', held_reason = NULL, last_rebaselined_at = ? WHERE source_key = ?",
		)
		.run(approvedHash, approvedHash, "2026-08-24T00:00:00.000Z", source);

	const fetcherFor = (body: Buffer) => async (): Promise<RawResult> => ({
		status: 200,
		ok: true,
		notModified: false,
		body,
		etag: null,
		lastModified: null,
		contentType: "text/html",
		finalUrl: config.terms_url,
	});

	// Archive the approved version, the way a check that saw it would have.
	await checkSingleSourceTos(source, { db, fetcher: fetcherFor(approved) });

	// A new headline: bytes differ, terms do not.
	const churned = page(
		"FBI raids supervisor's home",
		"You may not republish the Content.",
	);
	const churnRes = await checkSingleSourceTos(source, {
		db,
		fetcher: fetcherFor(churned),
	});
	assert.equal(churnRes.ok, false, "the source stays HELD either way");
	assert.match(churnRes.reason ?? "", /volatile-only/);

	// And it clears in one command, with the evidence recorded.
	const attested = attestSource(db, source, "2026-08-25T00:00:00.000Z");
	assert.equal(attested.ok, true, attested.message);
	assert.equal(db.getSourceTosStatus(source).status, "enabled");
	assert.equal(db.getSourceTosStatus(source).attestCount, 1);

	// A real clause change is a different answer, and attestation refuses it.
	const edited = page(
		"FBI raids supervisor's home",
		"You may republish the Content for AI training.",
	);
	const editRes = await checkSingleSourceTos(source, {
		db,
		fetcher: fetcherFor(edited),
	});
	assert.equal(editRes.ok, false);
	assert.doesNotMatch(editRes.reason ?? "", /volatile-only/);
	assert.match(editRes.reason ?? "", /terms text or its link targets differ/);

	const refused = attestSource(db, source, "2026-08-26T00:00:00.000Z");
	assert.equal(refused.ok, false);
	assert.match(refused.message, /refusing to attest/);
	assert.equal(db.getSourceTosStatus(source).status, "held");
});

test("rebaseline shows the terms before it will record that they were read", () => {
	const db = openDb(join(tmpDir, "rebase.db"));
	const source = "champion-news";
	const status = db.getSourceTosStatus(source);
	if (!status.lastObservedHash) {
		// Nothing observed in this fresh db: the command must say so rather than
		// clear a hold against a version it cannot show anyone.
		const res = rebaselineSource(db, source, { confirmed: true });
		assert.equal(res.ok, false);
		assert.match(res.message, /nothing to re-baseline/);
	}
});

test("rebaseline shows the terms even when the operator passes the flag up front", () => {
	// --rebaseline is what the attestation lease escalates to. If it could
	// record a re-read in a run that displayed nothing, the lease would expire
	// into an equally cheap action.
	const db = openDb(join(tmpDir, "shown.db"));
	const source = "champion-news";
	const body = Buffer.from(
		`<html><body><article id="staticpage"><p>These Terms of Service govern your use of ` +
			`ChampionNewspapers.com. ${"Padding to clear the length floor. ".repeat(700)}</p></article></body></html>`,
	);
	const { hash } = saveRaw(body, "html");
	db.raw
		.prepare(
			"UPDATE source_tos_status SET last_observed_hash = ?, status = 'held', held_reason = 'terms_hash_drift' WHERE source_key = ?",
		)
		.run(hash, source);

	const res = rebaselineSource(db, source, {
		confirmed: true,
		now: "2026-08-25T00:00:00.000Z",
	});
	assert.equal(res.ok, true, res.message);
	assert.match(res.message, /These Terms of Service govern your use of/);
	assert.equal(db.getSourceTosStatus(source).anchorHash, hash);

	// And the record identifies what was read, not just how long it was.
	const row = db.raw
		.prepare(
			"SELECT evidence FROM tos_attestations WHERE source_key = ? ORDER BY id DESC LIMIT 1",
		)
		.get(source) as { evidence: string };
	assert.match(row.evidence, /non-volatile digest [0-9a-f]{12}/);
	// The count measures the reduced terms, not this function's formatting: the
	// printed text has the link block appended and would read longer.
	const counted = Number(/\((\d+) chars/.exec(row.evidence)?.[1]);
	assert.ok(
		counted > 0 && counted < res.message.length,
		`evidence should count the reduced terms, got ${row.evidence}`,
	);
});

test("a retargeted link is described as such, and shown to the operator", () => {
	// Both halves of the same gap: hrefs are compared, so the message must not
	// call it a text change, and --rebaseline must not hide the one difference
	// an operator would be certifying they had read.
	const db = openDb(join(tmpDir, "links.db"));
	const source = "champion-news";
	const padding = "Padding to clear the length floor. ".repeat(700);
	const page = (href: string) =>
		Buffer.from(
			`<html><body><article id="staticpage">` +
				`<p>These Terms of Service govern your use of ChampionNewspapers.com. ${padding}</p>` +
				`<p>See our <a href="${href}">Privacy Policy</a>.</p>` +
				`</article></body></html>`,
		);

	const approved = page("/site/privacy.html");
	const { hash: approvedHash } = saveRaw(approved, "html");
	const retargeted = page("/site/privacy-v2.html");
	const { hash: observedHash } = saveRaw(retargeted, "html");

	db.raw
		.prepare(
			"UPDATE source_tos_status SET reviewed_hash = ?, anchor_hash = ?, last_observed_hash = ?, status = 'held', held_reason = 'terms_hash_drift' WHERE source_key = ?",
		)
		.run(approvedHash, approvedHash, observedHash, source);

	const classified = classifyKnownDrift(db, source, observedHash);
	assert.equal(classified?.verdict, "terms-changed");
	assert.match(classified?.detail ?? "", /link targets/);

	const shown = rebaselineSource(db, source, { confirmed: false });
	assert.match(shown.message, /privacy-v2\.html/);
});

test("attestation refuses a hold that is not about drift", () => {
	// It answers one question — did this drift change only the volatile region?
	// A fetch_error hold means the terms were never retrieved and the archived
	// copies are stale; clearing it would be answering a question nobody asked.
	const db = openDb(join(tmpDir, "notdrift.db"));
	const source = "champion-news";
	db.raw
		.prepare(
			"UPDATE source_tos_status SET last_observed_hash = ?, status = 'held', held_reason = ? WHERE source_key = ?",
		)
		.run("d".repeat(64), "fetch_error: HTTP 503", source);

	const res = attestSource(db, source);
	assert.equal(res.ok, false);
	assert.match(res.message, /not a terms-drift hold/);
	assert.equal(db.getSourceTosStatus(source).status, "held");
});

test("--reset anchors the version, so the short path works afterwards", async (t) => {
	// A reset is a full read: someone changed the approved hash in tos-config.
	// If it left no anchor, the next drift would find none and --attest would
	// refuse for a source that had just been reviewed in full.
	const db = openDb(join(tmpDir, "resetanchor.db"));
	const source = "champion-news";
	const config = SOURCE_TOS_REGISTRY[source];

	// Needs a source that is both SCOPED and resettable, and champion-news is
	// the only scoped one. Its baseline is `held` by the terms decision in
	// tos-config.ts, which resetSourceTosHold refuses, so that is overridden for
	// this test and restored after — as reviewed_hash already is below.
	const originalStatus = config.status;
	(config as { status: "enabled" | "held" }).status = "enabled";
	t.after(() => {
		(config as { status: "enabled" | "held" }).status = originalStatus;
	});
	const body = Buffer.from("<html><body>terms v1</body></html>");
	const hash = createHash("sha256").update(body).digest("hex");

	const original = config.reviewed_hash;
	(config as { reviewed_hash: string }).reviewed_hash = hash;
	t.after(() => {
		(config as { reviewed_hash: string }).reviewed_hash = original;
	});

	await resetSingleSourceTos(source, {
		db,
		now: "2026-08-25T00:00:00.000Z",
		fetcher: async () => ({
			status: 200,
			ok: true,
			notModified: false,
			body,
			etag: null,
			lastModified: null,
			contentType: "text/html",
			finalUrl: config.terms_url,
		}),
	});

	const status = db.getSourceTosStatus(source);
	assert.equal(status.status, "enabled");
	assert.equal(status.anchorHash, hash, "the reset must anchor the version");
	assert.equal(status.attestCount, 0);
	assert.equal(status.lastRebaselinedAt, "2026-08-25T00:00:00.000Z");

	// And it leaves a record, like every other clearance.
	const row = db.raw
		.prepare(
			"SELECT kind, evidence FROM tos_attestations WHERE source_key = ? ORDER BY id DESC LIMIT 1",
		)
		.get(source) as { kind: string; evidence: string };
	assert.equal(row.kind, "rebaseline");
	assert.match(row.evidence, /tos-config\.ts/);
});

test("evidence names only what was actually removed", () => {
	// A scope with no `volatile` selector strips nothing but script and style.
	// Claiming a volatile subtree was removed would put a thing that does not
	// exist into the stored attestation evidence.
	const db = openDb(join(tmpDir, "novolatile.db"));
	const source = "champion-news";
	const config = SOURCE_TOS_REGISTRY[source];
	const original = config.scope;
	config.scope = {
		select: "article#staticpage",
		anchor: "These Terms of Service govern your use of",
		minLength: 100,
	};

	try {
		const body = Buffer.from(
			`<html><body><article id="staticpage"><p>These Terms of Service govern your use of ` +
				`ChampionNewspapers.com. ${"Padding past the floor. ".repeat(20)}</p></article></body></html>`,
		);
		const { hash } = saveRaw(body, "html");
		db.raw
			.prepare(
				"UPDATE source_tos_status SET anchor_hash = ?, last_observed_hash = ?, status = 'held', held_reason = 'terms_hash_drift' WHERE source_key = ?",
			)
			.run(hash, hash, source);

		const res = classifyKnownDrift(db, source, hash);
		assert.equal(res?.verdict, "volatile-only");
		assert.match(res?.detail ?? "", /once script and style are removed/);
		assert.doesNotMatch(res?.detail ?? "", /volatile region/);
	} finally {
		config.scope = original;
	}
});
