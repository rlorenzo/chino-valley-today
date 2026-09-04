// Weekly terms-of-service drift detection, and the operator commands that
// clear a hold. Terms pages are fetched under the same fail-closed robots and
// redirect-safe HTTPS policy the scrapers use. Runs Sun 04:00 PT via systemd.
//
//   node scripts/check-tos-drift.ts
//       check every tracked source; hold any whose bytes changed
//   node scripts/check-tos-drift.ts --diff <source>
//       show what changed, as text rather than as two hashes
//   node scripts/check-tos-drift.ts --attest <source>
//       clear a hold the short way, where the tool has established that the
//       terms read the same once the source's declared volatile region is
//       removed — which is not the same as proving the raw documents differ
//       only there. Leased: see MAX_CONSECUTIVE_ATTESTATIONS and
//       ATTEST_LEASE_DAYS in tos-config.ts.
//   node scripts/check-tos-drift.ts --rebaseline <source> [--i-have-read-the-terms]
//       print the terms, then record that a human read them. This re-anchors
//       the version drift is measured from and resets the attestation lease.
//   node scripts/check-tos-drift.ts --reset <source>
//       adopt the registry's reviewed_hash constant after editing tos-config.ts
//       by hand. Predates the two above; still the path when the baseline
//       changes in code rather than from an observation.

import { openDb, type SourceTosStatus } from "../src/db/index.ts";
import { politeFetch } from "../src/fetch.ts";
import {
	classifyDrift,
	type DriftVerdict,
	readNonVolatile,
} from "../src/gates/terms-scope.ts";
import {
	ATTEST_LEASE_DAYS,
	MAX_CONSECUTIVE_ATTESTATIONS,
	SOURCE_TOS_REGISTRY,
	type SourceTosConfig,
} from "../src/gates/tos-config.ts";
import { extFor, findRaw, readRaw, saveRaw } from "../src/store.ts";
import { errorMessage } from "../src/utils/errors.ts";
import { diffLines, formatDiff } from "../src/utils/line-diff.ts";

function requireConfig(sourceKey: string): SourceTosConfig {
	const config = SOURCE_TOS_REGISTRY[sourceKey];
	if (!config) {
		throw new Error(`Unknown source key in ToS registry: ${sourceKey}`);
	}
	return config;
}

/**
 * Fetches a publisher's terms page under the same fail-closed robots, HTTPS and
 * redirect policy the scrapers use, and returns the sha256 of what came back.
 *
 * The bytes are ARCHIVED as well as hashed. `source_tos_status` stores only
 * `reviewed_hash` and `last_observed_hash`, so a drift hold could report that
 * something changed and nothing more: on 2026-08-23 three sources held at once
 * and answering "what changed?" meant reading three publishers' terms pages by
 * hand, which is most of the effort and all of the tedium. Two of the three
 * were large media-group boilerplate that had almost certainly changed for
 * reasons having nothing to do with us — exactly the case a diff settles in
 * seconds.
 *
 * The archive is content-addressed by the same sha256 the status table already
 * stores, so those two columns become pointers into it and nothing new has to
 * be recorded. It also dedupes: a weekly check of an unchanged page writes
 * nothing after the first time.
 */
async function fetchTerms(
	config: SourceTosConfig,
	fetcher: typeof politeFetch,
): Promise<{ ok: boolean; status: number; hash: string }> {
	const bare = new URL(config.terms_url).hostname.replace(/^www\./, "");
	const res = await fetcher(config.terms_url, {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: [bare, `www.${bare}`],
		maxRedirectHops: 3,
	});
	if (!res.ok) return { ok: false, status: res.status, hash: "" };

	// saveRaw returns the sha256 of these exact bytes, which is the hash the
	// status table stores. Taking it from here rather than hashing separately
	// keeps the archive and the hold record from ever disagreeing about which
	// version was seen.
	const { hash } = saveRaw(res.body, extFor(res.contentType, config.terms_url));
	return { ok: true, status: res.status, hash };
}

// The handful of entities that appear in prose. Decoded in ONE pass, below:
// running a replace per entity re-scans its own output, so "&amp;lt;" — which
// is the literal text "&lt;" — would come back as "<".
const ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&#39;": "'",
};

// What a "terms page" actually is, per source: 3 of the 10 tracked sources
// point at an HTML terms document, and the other 7 point at a robots.txt,
// which SOURCES.md records as the binding access document where a publisher
// has no separate terms page. So this reduces two different kinds of file, and
// the difference matters rather than being a naming detail.
//
// HTML is stripped to the words a person would read, because diffing markup
// would report a rotated ad slot or a rebuilt asset id as a terms change.
//
// Plain text is left alone. robots.txt is line-oriented and its BLANK LINES
// ARE SEMANTIC — a blank line ends a user-agent group — so the whitespace
// collapsing that makes HTML readable would report "Disallow: /" moving from
// one group to every crawler as no change at all, on the one document that
// governs whether we may fetch the site.
function htmlToLines(html: string): string[] {
	return (
		html
			// An end tag is "</name" followed by anything up to ">", because that
			// is what a browser accepts: "</script >" and "</script\n foo>" both
			// close a script. A pattern that misses either leaves the script body
			// in the compared text, where a rotating build id then reads as a
			// change to someone's terms of service.
			.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:\s[^>]*)?>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style(?:\s[^>]*)?>/gi, " ")
			// An unclosed script or style would otherwise survive the tag strip
			// below as its own text; drop everything from the opening tag on.
			.replace(/<(script|style)\b[\s\S]*$/i, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			// Block-level tags become line breaks so a clause stays one line.
			.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)\b[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(
				/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g,
				(entity) => ENTITIES[entity] ?? entity,
			)
			.split("\n")
			.map((line) => line.replace(/[ \t]+/g, " ").trim())
			.filter((line) => line.length > 0)
	);
}

// Only line endings are normalised, so a file that changed from CRLF to LF and
// nothing else does not read as every line changing. Everything a person could
// have edited — blank lines, indentation, trailing spaces — survives.
function plainTextLines(text: string): string[] {
	return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Reduces one archived document to the lines worth comparing, choosing how by
 * what the file is.
 *
 * The archive is content-addressed as `<sha256>.<ext>`, and that extension is
 * `extFor`'s reading of the response's content type — so the archive filename
 * already records whether this was served as HTML, and nothing has to be
 * re-sniffed or stored.
 */
export function termsLines(body: string, rawPath: string): string[] {
	return /\.html?$/i.test(rawPath) ? htmlToLines(body) : plainTextLines(body);
}

/**
 * The source's current gate state, for a diff message that would otherwise
 * read as all-clear while the source is still held.
 */
function statusLine(status: SourceTosStatus): string {
	return status.status === "held"
		? `  status: held (${status.heldReason ?? "no reason recorded"})`
		: `  status: ${status.status}`;
}

/**
 * Prints what changed between the terms a human approved and the terms
 * currently observed, for a source sitting on a drift hold.
 */
export function diffTerms(
	db: ReturnType<typeof openDb>,
	sourceKey: string,
): { ok: boolean; message: string } {
	requireConfig(sourceKey);
	const status = db.getSourceTosStatus(sourceKey);
	const observed = status.lastObservedHash;

	// No observed hash is not agreement. A source held on a fetch error, or on
	// an unreviewed baseline, never recorded a version to compare against, so
	// "no drift" would tell an operator the terms match when the truth is that
	// nothing was ever seen — and would exit 0 on a source that is held.
	if (!observed) {
		return {
			ok: false,
			message:
				`${sourceKey}: nothing to diff — no observed terms have been recorded.\n` +
				`${statusLine(status)}\n` +
				"  A check that reaches the page records one; --reset adopts it as reviewed.",
		};
	}

	if (observed === status.reviewedHash) {
		return {
			ok: true,
			message:
				`${sourceKey}: no drift — the observed terms match the reviewed ones.\n` +
				statusLine(status),
		};
	}

	const before = findRaw(status.reviewedHash);
	const after = findRaw(observed);
	// An archive entry is missing whenever the version predates this archiving,
	// which is true of every hash reviewed before 2026-08-24. Say which one is
	// missing rather than printing an empty diff that reads like "no changes".
	if (!before || !after) {
		const missing = [
			!before ? `reviewed (${status.reviewedHash.slice(0, 10)})` : null,
			!after ? `observed (${observed.slice(0, 10)})` : null,
		].filter(Boolean);
		return {
			ok: false,
			message:
				`${sourceKey}: cannot diff — no archived copy of the ${missing.join(" or ")} terms.\n` +
				`${statusLine(status)}\n` +
				"  Versions fetched before this archiving exist only as hashes. The next\n" +
				"  check archives what it sees, so the drift after this one is diffable.",
		};
	}

	const result = diffLines(
		termsLines(readRaw(before).toString("utf8"), before),
		termsLines(readRaw(after).toString("utf8"), after),
	);
	// Each side is reduced by what it actually is. If those disagree, the
	// publisher started serving a different kind of document at the same URL —
	// worth an operator's attention on its own, and a warning that the diff
	// below is between two shapes rather than two versions.
	const beforeExt = before.replace(/^.*\./, "");
	const afterExt = after.replace(/^.*\./, "");
	const typeChanged =
		beforeExt === afterExt
			? ""
			: `  NOTE: served as .${beforeExt} when reviewed, .${afterExt} now\n`;
	return {
		ok: true,
		message:
			`${sourceKey}: ${result.added} line(s) added, ${result.removed} removed\n` +
			`  reviewed ${status.reviewedHash.slice(0, 10)} -> observed ${observed.slice(0, 10)}\n` +
			typeChanged +
			`${statusLine(status)}\n\n` +
			formatDiff(result),
	};
}

/**
 * For a source whose bytes have drifted, says whether its TERMS drifted.
 *
 * Returns null where the question does not apply or cannot be answered, and
 * the caller then leaves the ordinary drift hold in place. Every path here is
 * advisory: nothing in this function can clear a hold or keep one from being
 * set, so a bug in it costs an operator a wrong sentence, never a scrape we
 * were not allowed to make.
 */
export function classifyKnownDrift(
	db: ReturnType<typeof openDb>,
	sourceKey: string,
	observedHash: string,
): { verdict: DriftVerdict["verdict"]; detail: string } | null {
	const scope = SOURCE_TOS_REGISTRY[sourceKey]?.scope;
	if (!scope) return null;

	const status = db.getSourceTosStatus(sourceKey);
	// The anchor is the version a human read in full. Falling back to
	// reviewed_hash covers the first drift after this shipped, when nothing has
	// been re-baselined yet but the reviewed version may well be archived.
	const anchorHash = status.anchorHash ?? status.reviewedHash;
	const anchorPath = anchorHash ? findRaw(anchorHash) : null;
	const observedPath = findRaw(observedHash);
	if (!anchorPath || !observedPath) return null;

	try {
		const verdict = classifyDrift(
			readRaw(anchorPath).toString("utf8"),
			readRaw(observedPath).toString("utf8"),
			scope,
		);
		if (verdict.verdict === "volatile-only") {
			// Precise about what was actually established, because this string
			// becomes the attestation evidence someone reads back later. What is
			// known is that the REDUCED readings match — not that the raw bytes
			// differ only inside the volatile region.
			// Name only what was actually removed. A scope with no `volatile`
			// selector strips nothing but script and style, and saying otherwise
			// would put a subtree that does not exist into the stored evidence.
			const removed = scope.volatile
				? `${scope.volatile}, script and style are`
				: "script and style are";
			return {
				verdict: "volatile-only",
				detail:
					`the terms text and link targets within ${scope.select} are identical to the approved ` +
					`version, once ${removed} removed`,
			};
		}
		if (verdict.verdict === "terms-changed") {
			// Link targets are part of the canonical form, so "the text differs"
			// would misdescribe a retargeted link — the case where the wording is
			// identical and the destination is not.
			return {
				verdict: "terms-changed",
				detail: "the terms text or its link targets differ",
			};
		}
		return { verdict: "indeterminate", detail: verdict.reason };
	} catch (err) {
		return {
			verdict: "indeterminate",
			detail: `classification failed: ${errorMessage(err)}`,
		};
	}
}

export async function checkSingleSourceTos(
	sourceKey: string,
	opts: {
		db: ReturnType<typeof openDb>;
		now?: string;
		fetcher?: typeof politeFetch;
	},
): Promise<{
	ok: boolean;
	status: SourceTosStatus["status"];
	reason?: string;
	hash: string;
}> {
	const config = requireConfig(sourceKey);
	const checkedAt = opts.now ?? new Date().toISOString();

	try {
		const res = await fetchTerms(config, opts.fetcher ?? politeFetch);

		if (!res.ok) {
			const reason = `fetch_error: HTTP ${res.status}`;
			opts.db.setSourceTosHold(sourceKey, { reason, checkedAt });
			return { ok: false, status: "held", reason, hash: "" };
		}

		opts.db.recordSourceTosCheck(sourceKey, {
			observedHash: res.hash,
			checkedAt,
		});

		// Re-read rather than infer: recordSourceTosCheck may have just placed a
		// drift hold, and an earlier hold survives a matching hash by design.
		const current = opts.db.getSourceTosStatus(sourceKey);
		if (current.status === "held") {
			// Say which KIND of drift this is, if the source is one that carries a
			// scope. The source stays held either way — this only decides whether
			// the operator faces a one-command clearance or an afternoon.
			// Prefix, not equality. The first classified run rewrites this reason
			// into its annotated form, so an exact match would never reclassify —
			// freezing a "volatile-only" label over a later real edit and pointing
			// the operator at --attest for something that is not attestable.
			if (current.heldReason?.startsWith("terms_hash_drift")) {
				const classified = classifyKnownDrift(opts.db, sourceKey, res.hash);
				// Only a CONCLUSIVE verdict is written into the hold reason. An
				// indeterminate one tells an operator nothing they can act on, and
				// stamping a parser complaint over "terms_hash_drift" would bury the
				// fact that matters — that the terms drifted. It still gets said out
				// loud, because a scope that has quietly stopped working would
				// otherwise make every future drift unclassifiable in silence.
				if (classified && classified.verdict === "indeterminate") {
					console.error(
						`  NOTE: ${sourceKey}'s terms scope could not classify this drift: ${classified.detail}`,
					);
				}
				if (classified && classified.verdict !== "indeterminate") {
					const reason =
						classified.verdict === "volatile-only"
							? `terms_hash_drift (volatile-only: ${classified.detail})`
							: `terms_hash_drift (${classified.detail})`;
					opts.db.setSourceTosHold(sourceKey, {
						reason,
						observedHash: res.hash,
						checkedAt,
					});
					return { ok: false, status: "held", reason, hash: res.hash };
				}
			}
			return {
				ok: false,
				status: "held",
				reason: current.heldReason ?? "baseline_held",
				hash: res.hash,
			};
		}

		return { ok: true, status: "enabled", hash: res.hash };
	} catch (err) {
		const reason = `fetch_error: ${errorMessage(err)}`;
		opts.db.setSourceTosHold(sourceKey, {
			reason,
			checkedAt,
		});
		return { ok: false, status: "held", reason, hash: "" };
	}
}

export async function resetSingleSourceTos(
	sourceKey: string,
	opts: {
		db: ReturnType<typeof openDb>;
		now?: string;
		fetcher?: typeof politeFetch;
	},
): Promise<{ ok: boolean; hash: string }> {
	const config = requireConfig(sourceKey);
	const checkedAt = opts.now ?? new Date().toISOString();

	const res = await fetchTerms(config, opts.fetcher ?? politeFetch);
	if (!res.ok) {
		throw new Error(
			`Cannot reset ToS hold: fetch failed with HTTP ${res.status}`,
		);
	}

	// resetSourceTosHold owns the baseline-status and hash checks; duplicating
	// them here would give the two call sites room to disagree.
	opts.db.resetSourceTosHold(sourceKey, {
		observedHash: res.hash,
		checkedAt,
	});

	return { ok: true, hash: res.hash };
}

/**
 * Clears a drift hold in the short form: the tool has established that the
 * terms read the same once the declared volatile region is removed, so the
 * operator signs that finding rather than re-reading the terms. What is signed
 * is exactly that — the reduced readings match — and not the stronger claim
 * that the raw documents differ only inside the region.
 *
 * Leased, so this cannot become the only form of review a source ever gets.
 */
export function attestSource(
	db: ReturnType<typeof openDb>,
	sourceKey: string,
	now?: string,
): { ok: boolean; message: string } {
	requireConfig(sourceKey);
	const status = db.getSourceTosStatus(sourceKey);
	const observed = status.lastObservedHash;
	if (!observed) {
		return {
			ok: false,
			message: `${sourceKey}: nothing to attest — no observed terms recorded.`,
		};
	}
	if (status.status === "enabled" && observed === status.reviewedHash) {
		return { ok: true, message: `${sourceKey}: already enabled and matching.` };
	}

	// Attestation answers exactly one question — "did this drift change only the
	// volatile region?" — so it may only clear a hold that asked it. A
	// fetch_error hold means the terms were never retrieved, and the archived
	// versions it would compare are both stale; a baseline_held or
	// unreviewed_source hold is not about drift at all. Clearing any of those on
	// the strength of comparing two old copies would be answering a question
	// nobody asked.
	if (
		status.status !== "held" ||
		!status.heldReason?.startsWith("terms_hash_drift")
	) {
		return {
			ok: false,
			message:
				`${sourceKey}: refusing to attest — this is not a terms-drift hold ` +
				`(status ${status.status}, reason ${status.heldReason ?? "none"}).\n` +
				"  Attestation only clears a drift whose scope comparison it can make.",
		};
	}

	const classified = classifyKnownDrift(db, sourceKey, observed);
	if (!classified) {
		return {
			ok: false,
			message:
				`${sourceKey}: cannot attest — this source has no terms scope, or the versions to\n` +
				"  compare are not both archived. Read the terms and use --rebaseline.",
		};
	}
	if (classified.verdict !== "volatile-only") {
		return {
			ok: false,
			message:
				`${sourceKey}: refusing to attest — ${classified.detail}.\n` +
				`  Read them: node scripts/check-tos-drift.ts --diff ${sourceKey}`,
		};
	}

	try {
		db.attestSourceTos(sourceKey, {
			observedHash: observed,
			evidence: classified.detail,
			attestedAt: now,
			maxAttestations: MAX_CONSECUTIVE_ATTESTATIONS,
			leaseDays: ATTEST_LEASE_DAYS,
		});
	} catch (err) {
		return { ok: false, message: `${sourceKey}: ${errorMessage(err)}` };
	}
	const after = db.getSourceTosStatus(sourceKey);
	return {
		ok: true,
		message:
			`${sourceKey}: attested and re-enabled (${classified.detail}).\n` +
			`  ${after.attestCount} of ${MAX_CONSECUTIVE_ATTESTATIONS} attestations used since the last full read.`,
	};
}

/**
 * Clears a hold the long way: print the terms, then record that a human read
 * them. This is what re-anchors the version drift is measured from, and the
 * only thing that resets the attestation lease.
 */
export function rebaselineSource(
	db: ReturnType<typeof openDb>,
	sourceKey: string,
	opts: { confirmed: boolean; now?: string },
): { ok: boolean; message: string } {
	const config = requireConfig(sourceKey);
	const status = db.getSourceTosStatus(sourceKey);
	const observed = status.lastObservedHash;
	if (!observed) {
		return {
			ok: false,
			message: `${sourceKey}: nothing to re-baseline — no observed terms recorded.`,
		};
	}
	const path = findRaw(observed);
	if (!path) {
		return {
			ok: false,
			message:
				`${sourceKey}: the observed version (${observed.slice(0, 10)}) is not in the archive,\n` +
				"  so there is nothing to show you. Run a check first.",
		};
	}

	const body = readRaw(path).toString("utf8");
	const scope = config.scope;
	const reading = scope ? readNonVolatile(body, scope) : null;
	// Link targets are compared but invisible in the text, so an operator asked
	// to certify they read the terms has to be shown them too. A retargeted
	// link under unchanged wording is one of the drifts this catches, and it
	// would otherwise be the one change they could not review.
	const links =
		reading?.ok && reading.hrefs.length > 0
			? `\n\nLink targets (compared, and not visible above):\n${reading.hrefs
					.map((h) => `  ${h}`)
					.join("\n")}`
			: "";
	const text =
		(reading?.ok ? reading.text : termsLines(body, path).join("\n")) + links;

	// A scope that could not be applied must be said out loud. Otherwise the
	// operator re-baselines believing they read the scoped terms, anchor_hash is
	// set to a version whose scope cannot be read, and every later drift
	// classifies as indeterminate with no explanation at the point of confusion.
	const scopeWarning =
		scope && !reading?.ok
			? `  NOTE: this source's terms scope did not apply (${reading?.ok === false ? reading.reason : "unknown"}),\n` +
				"  so what follows is the whole page, not the scoped terms.\n\n"
			: "";

	// Printed on BOTH paths. Recording a re-read in a run that displayed nothing
	// would be a signature on an unopened document, and --rebaseline is the
	// forcing function the attestation lease escalates to.
	const shown =
		`${sourceKey} — terms as currently served (${observed.slice(0, 10)}):\n\n` +
		`${scopeWarning}${text}\n`;

	if (!opts.confirmed) {
		return {
			ok: false,
			message: `${shown}\n  Read the above. If you accept it, re-run with --i-have-read-the-terms.`,
		};
	}

	// The scoped reading is what the operator was shown, so its digest is what
	// the record should be able to reconstruct. to_hash covers the raw document.
	//
	// The count comes from the READING, not from `text`: `text` has the link
	// block and any warning appended for display, so counting it would record a
	// number that measures this function's formatting rather than the terms.
	const evidence = reading?.ok
		? `operator re-read the terms (${reading.length} chars, non-volatile digest ${reading.digest.slice(0, 12)})`
		: `operator re-read the whole page (${text.length} chars; scope did not apply)`;
	db.rebaselineSourceTos(sourceKey, {
		observedHash: observed,
		evidence,
		attestedAt: opts.now,
	});
	return {
		ok: true,
		message:
			`${shown}\n${sourceKey}: re-baselined and re-enabled. Future drift is measured from this\n` +
			`  version, and the attestation lease is reset.`,
	};
}

/** The per-source flags all take a source key as their one argument. */
function requireSourceKey(args: string[]): string {
	const key = args[1];
	if (!key) {
		console.error(
			`Usage: node scripts/check-tos-drift.ts ${args[0]} <source_key>`,
		);
		process.exit(1);
	}
	return key;
}

async function main() {
	const args = process.argv.slice(2);
	const db = openDb();

	if (args[0] === "--diff") {
		const targetKey = requireSourceKey(args);
		// requireConfig throws on a key that is not in the registry. Caught here
		// so an operator's typo gets the same one-line answer --reset gives,
		// rather than a stack trace.
		try {
			const res = diffTerms(db, targetKey);
			console.log(res.message);
			process.exit(res.ok ? 0 : 1);
		} catch (err) {
			console.error(`Diff failed: ${errorMessage(err)}`);
			console.error(
				`  known sources: ${Object.keys(SOURCE_TOS_REGISTRY).join(", ")}`,
			);
			process.exit(1);
		}
	}

	if (args[0] === "--attest" || args[0] === "--rebaseline") {
		const targetKey = requireSourceKey(args);
		try {
			const res =
				args[0] === "--attest"
					? attestSource(db, targetKey)
					: rebaselineSource(db, targetKey, {
							confirmed: args.includes("--i-have-read-the-terms"),
						});
			console.log(res.message);
			process.exit(res.ok ? 0 : 1);
		} catch (err) {
			console.error(`Failed: ${errorMessage(err)}`);
			console.error(
				`  known sources: ${Object.keys(SOURCE_TOS_REGISTRY).join(", ")}`,
			);
			process.exit(1);
		}
	}

	if (args[0] === "--reset") {
		const targetKey = requireSourceKey(args);
		console.log(`Attempting operator reset for ToS status on ${targetKey}...`);
		try {
			const res = await resetSingleSourceTos(targetKey, { db });
			console.log(
				`Successfully reset ToS status for ${targetKey} to 'enabled' (hash: ${res.hash})`,
			);
			process.exit(0);
		} catch (err) {
			console.error(`Reset failed: ${errorMessage(err)}`);
			process.exit(1);
		}
	}

	console.log("Starting weekly Terms of Service drift checks...");
	let allOk = true;

	for (const sourceKey of Object.keys(SOURCE_TOS_REGISTRY)) {
		console.log(`Checking ToS for ${sourceKey}...`);
		const result = await checkSingleSourceTos(sourceKey, { db });
		if (!result.ok) {
			allOk = false;
			console.error(
				`  FAILED: ${sourceKey} status is now HELD (reason: ${result.reason}, observed hash: ${result.hash})`,
			);
		} else {
			console.log(
				`  OK: ${sourceKey} verified (status: enabled, hash: ${result.hash})`,
			);
		}
	}

	if (allOk) {
		const heartbeatUrl = process.env.CVT_HEARTBEAT_URL_TOS;
		if (heartbeatUrl) {
			try {
				await fetch(heartbeatUrl, { signal: AbortSignal.timeout(10000) });
				console.log("Sent heartbeat ping to CVT_HEARTBEAT_URL_TOS");
			} catch (err) {
				console.error("Failed to ping heartbeat URL:", err);
			}
		}
		console.log("All ToS checks passed.");
		process.exit(0);
	} else {
		console.error("One or more ToS checks failed or held.");
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error("Fatal ToS check error:", err);
		process.exit(1);
	});
}
