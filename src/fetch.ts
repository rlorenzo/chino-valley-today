// Polite fetcher: custom UA with contact, robots.txt respect, per-host rate
// limit, conditional GET support. All scraper HTTP goes through politeFetch.

export const USER_AGENT =
	"ChinoValleyTodayBot/0.1 (local news POC; contact: rexlorenzo@gmail.com)";

const MIN_DELAY_MS = 2000;

export interface FetchOpts {
	etag?: string | null;
	lastModified?: string | null;
	accept?: string;
	skipRobots?: boolean;
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

export function sleep(ms: number): Promise<void> {
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

async function getRobots(origin: string): Promise<RobotGroup[] | null> {
	if (robotsCache.has(origin)) return robotsCache.get(origin) ?? null;
	let groups: RobotGroup[] | null = null;
	try {
		const res = await fetch(`${origin}/robots.txt`, {
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(15000),
		});
		if (res.ok) groups = parseRobots(await res.text());
	} catch {
		// unreachable robots.txt -> proceed (fail open, but note nothing blocks)
	}
	robotsCache.set(origin, groups);
	return groups;
}

// ---- fetch ----

async function attempt(
	url: string,
	headers: Record<string, string>,
): Promise<Response> {
	return fetch(url, {
		headers,
		redirect: "follow",
		signal: AbortSignal.timeout(60000),
	});
}

export async function politeFetch(
	url: string,
	opts: FetchOpts = {},
): Promise<RawResult> {
	const u = new URL(url);
	if (!opts.skipRobots) {
		const groups = await getRobots(u.origin);
		if (groups && !isAllowed(groups, u.pathname + u.search)) {
			throw new Error(`robots.txt disallows ${url}`);
		}
	}
	await politeDelay(u.host);

	const headers: Record<string, string> = { "user-agent": USER_AGENT };
	if (opts.accept) headers.accept = opts.accept;
	if (opts.etag) headers["if-none-match"] = opts.etag;
	if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

	let res: Response;
	try {
		res = await attempt(url, headers);
		if (res.status >= 500) {
			await sleep(5000);
			res = await attempt(url, headers);
		}
	} catch {
		await sleep(5000);
		res = await attempt(url, headers);
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
		finalUrl: res.url || url,
	};
}
