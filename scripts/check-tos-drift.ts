// Weekly automated terms-of-service drift detection & operator reset utility.
// Checks publisher terms pages under fail-closed robots and redirect-safe HTTPS policies.
// Run weekly via systemd (Sun 04:00 PT) or manually via `node scripts/check-tos-drift.ts [--reset <source_key>]`.

import { createHash } from "node:crypto";
import { openDb, type SourceTosStatus } from "../src/db/index.ts";
import { politeFetch } from "../src/fetch.ts";
import {
	SOURCE_TOS_REGISTRY,
	type SourceTosConfig,
} from "../src/gates/tos-config.ts";
import { errorMessage } from "../src/utils/errors.ts";

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
	return {
		ok: res.ok,
		status: res.status,
		hash: res.ok ? createHash("sha256").update(res.body).digest("hex") : "",
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
