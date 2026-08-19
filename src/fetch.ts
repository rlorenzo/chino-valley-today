// Polite fetcher: custom UA with contact, robots.txt respect, per-host rate
// limit, conditional GET support. All scraper HTTP goes through politeFetch.

import { errorMessage } from "./utils/errors.ts";

const USER_AGENT =
	"ChinoValleyTodayBot/0.1 (local news POC; contact: rexlorenzo@gmail.com)";

const MIN_DELAY_MS = 2000;

export interface FetchOpts {
	etag?: string | null;
	lastModified?: string | null;
	accept?: string;
	skipRobots?: boolean;
	failClosedRobots?: boolean;
	allowedHosts?: string[];
	manualRedirect?: boolean;
	maxRedirectHops?: number;
}

export interface RawResult {
	status: number;
	ok: boolean;
	notModified: boolean;
	body: Buffer;
	etag: string | null;
	lastModified: string | null;
	contentType: string | null;
	finalUrl: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---- per-host rate limiting ----

const lastByHost = new Map<string, number>();

async function politeDelay(host: string): Promise<void> {
	const now = Date.now();
	const last = lastByHost.get(host) ?? 0;
	const wait = Math.max(0, last + MIN_DELAY_MS - now);
	lastByHost.set(host, now + wait);
	if (wait > 0) await sleep(wait);
}

// ---- robots.txt ----

interface RobotGroup {
	agents: string[];
	rules: Array<{ allow: boolean; pattern: string }>;
}

const robotsCache = new Map<string, RobotGroup[] | null>();

function parseRobots(txt: string): RobotGroup[] {
	const groups: RobotGroup[] = [];
	let current: RobotGroup | null = null;
	let lastWasAgent = false;
	for (const rawLine of txt.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const field = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (field === "user-agent") {
			if (!lastWasAgent || !current) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
		} else {
			lastWasAgent = false;
			if ((field === "allow" || field === "disallow") && current && value) {
				current.rules.push({ allow: field === "allow", pattern: value });
			}
		}
	}
	return groups;
}

function patternMatches(pattern: string, path: string): boolean {
	let p = pattern;
	let anchorEnd = false;
	if (p.endsWith("$")) {
		anchorEnd = true;
		p = p.slice(0, -1);
	}
	const escaped = p
		.split("*")
		.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}${anchorEnd ? "$" : ""}`).test(path);
}

function isAllowed(groups: RobotGroup[], path: string): boolean {
	const ua = "chinovalleytodaybot";
	let applicable = groups.filter((g) =>
		g.agents.some((a) => a !== "*" && ua.includes(a)),
	);
	if (applicable.length === 0)
		applicable = groups.filter((g) => g.agents.includes("*"));
	if (applicable.length === 0) return true;
	let best: { allow: boolean; len: number } | null = null;
	for (const g of applicable) {
		for (const r of g.rules) {
			if (patternMatches(r.pattern, path)) {
				const len = r.pattern.length;
				if (
					!best ||
					len > best.len ||
					(len === best.len && r.allow && !best.allow)
				) {
					best = { allow: r.allow, len };
				}
			}
		}
	}
	return best ? best.allow : true;
}

async function getRobots(
	origin: string,
	failClosed = false,
): Promise<RobotGroup[] | null> {
	if (robotsCache.has(origin)) return robotsCache.get(origin) ?? null;
	let groups: RobotGroup[] | null = null;
	try {
		const res = await fetch(`${origin}/robots.txt`, {
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(15000),
		});
		if (res.ok) {
			groups = parseRobots(await res.text());
		} else if (failClosed) {
			throw new Error(
				`robots.txt check failed (fail-closed, HTTP ${res.status})`,
			);
		}
	} catch (err) {
		if (failClosed) {
			throw new Error(
				`robots.txt check failed (fail-closed): ${errorMessage(err)}`,
			);
		}
		// unreachable robots.txt -> proceed (fail open, but note nothing blocks)
	}
	robotsCache.set(origin, groups);
	return groups;
}

// ---- fetch ----

function validateHostAndProtocol(url: string, allowedHosts?: string[]): URL {
	const u = new URL(url);
	if (allowedHosts && allowedHosts.length > 0) {
		if (u.protocol !== "https:") {
			throw new Error(`Insecure protocol rejected: ${u.protocol}`);
		}
		if (!allowedHosts.includes(u.hostname)) {
			throw new Error(
				`Host not allowed: ${u.hostname} (allowed: ${allowedHosts.join(", ")})`,
			);
		}
	}
	return u;
}

async function attempt(
	url: string,
	headers: Record<string, string>,
	redirect: "follow" | "manual" = "follow",
): Promise<Response> {
	return fetch(url, {
		headers,
		redirect,
		signal: AbortSignal.timeout(60000),
	});
}

export async function politeFetch(
	url: string,
	opts: FetchOpts = {},
): Promise<RawResult> {
	let currentUrl = url;
	const maxHops = opts.maxRedirectHops ?? 3;
	let hops = 0;

	while (true) {
		const u = validateHostAndProtocol(currentUrl, opts.allowedHosts);

		if (!opts.skipRobots) {
			const groups = await getRobots(u.origin, opts.failClosedRobots);
			if (groups && !isAllowed(groups, u.pathname + u.search)) {
				throw new Error(`robots.txt disallows ${currentUrl}`);
			}
		}
		await politeDelay(u.host);

		const headers: Record<string, string> = { "user-agent": USER_AGENT };
		if (opts.accept) headers.accept = opts.accept;
		// Only send conditional GET headers on initial request (hop 0)
		if (hops === 0) {
			if (opts.etag) headers["if-none-match"] = opts.etag;
			if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
		}

		const redirectMode = opts.manualRedirect ? "manual" : "follow";
		let res: Response;
		try {
			res = await attempt(currentUrl, headers, redirectMode);
			if (res.status >= 500) {
				await sleep(5000);
				res = await attempt(currentUrl, headers, redirectMode);
			}
		} catch (err) {
			// Sources onboarded fail-closed surface the transport error instead of
			// silently retrying: for those, whether the request happened at all is
			// part of what the caller is being asked to decide.
			if (opts.failClosedRobots) throw err;
			await sleep(5000);
			res = await attempt(currentUrl, headers, redirectMode);
		}

		// Handle manual redirect inspect loop
		if (opts.manualRedirect && [301, 302, 303, 307, 308].includes(res.status)) {
			const loc = res.headers.get("location");
			if (!loc) {
				throw new Error(
					`Redirect HTTP ${res.status} without Location header from ${currentUrl}`,
				);
			}
			hops++;
			if (hops > maxHops) {
				throw new Error(
					`Exceeded max redirect hops (${maxHops}) following ${url}`,
				);
			}
			const nextUrl = new URL(loc, currentUrl).toString();
			validateHostAndProtocol(nextUrl, opts.allowedHosts);
			currentUrl = nextUrl;
			continue;
		}

		const body = Buffer.from(await res.arrayBuffer());
		return {
			status: res.status,
			ok: res.ok,
			notModified: res.status === 304,
			body,
			etag: res.headers.get("etag"),
			lastModified: res.headers.get("last-modified"),
			contentType: res.headers.get("content-type"),
			finalUrl: opts.manualRedirect ? currentUrl : res.url || currentUrl,
		};
	}
}
