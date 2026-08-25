// Weekly automated terms-of-service drift detection & operator reset utility.
// Checks publisher terms pages under fail-closed robots and redirect-safe HTTPS policies.
// Run weekly via systemd (Sun 04:00 PT) or manually via `node scripts/check-tos-drift.ts [--reset <source_key>]`.

import { openDb, type SourceTosStatus } from "../src/db/index.ts";
import { politeFetch } from "../src/fetch.ts";
import {
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

async function main() {
	const args = process.argv.slice(2);
	const db = openDb();

	if (args[0] === "--diff") {
		const targetKey = args[1];
		if (!targetKey) {
			console.error(
				"Usage: node scripts/check-tos-drift.ts --diff <source_key>",
			);
			process.exit(1);
		}
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

	if (args[0] === "--reset") {
		const targetKey = args[1];
		if (!targetKey) {
			console.error(
				"Usage: node scripts/check-tos-drift.ts --reset <source_key>",
			);
			process.exit(1);
		}
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
