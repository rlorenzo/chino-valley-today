// Writes content/elections/<date>.json, the data behind /elections/<date>/.
// Runs every morning, but the file only changes when the results changed and
// the last revision is about a week old, so the public page moves weekly while
// the brief keeps showing each new count. One file revised in place with a
// dated history, because a post may not be silently edited once published.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/index.ts";
import { ROOT } from "../store.ts";
import { type ItemRow, parseMeta, queryItems } from "../tiera/queries.ts";

// A half day short of seven, so a revision that ran a few seconds later than
// last week's does not slip a whole extra day.
const MIN_HOURS_BETWEEN_UPDATES = 7 * 24 - 12;

const GROUPS = [
	{ prefix: "City of Chino Hills ", group: "City of Chino Hills" },
	{ prefix: "City of Chino ", group: "City of Chino" },
	{
		prefix: "Chino Valley Unified School District ",
		group: "Chino Valley Unified School District",
	},
	{
		prefix: "Chino Valley Independent Fire District ",
		group: "Chino Valley Independent Fire District",
	},
];

interface Choice {
	name: string;
	votes: number;
	percent: string;
}

interface Contest {
	group: string;
	name: string;
	choices: Choice[];
}

export interface ElectionPage {
	election_date: string;
	report: string;
	status: string | null;
	updated_at: string;
	source_url: string;
	contests: Contest[];
	history: { report: string; updated_at: string }[];
}

function toContest(item: ItemRow): Contest {
	const title = item.title ?? "";
	const match = GROUPS.find((g) => title.startsWith(g.prefix));
	return {
		group: match?.group ?? "Other local contests",
		name: match ? title.slice(match.prefix.length) : title,
		choices: parseMeta(item.meta).choices as Choice[],
	};
}

function sortContests(contests: Contest[]): Contest[] {
	const rank = (c: Contest) => {
		const i = GROUPS.findIndex((g) => g.group === c.group);
		return i === -1 ? GROUPS.length : i;
	};
	const isMeasure = (c: Contest) => /^measure/i.test(c.name);
	return [...contests].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			Number(isMeasure(a)) - Number(isMeasure(b)) ||
			a.name.localeCompare(b.name),
	);
}

/**
 * Drops contests the registrar's latest report no longer lists. Every scrape
 * rewrites each listed contest's report, so a stale one has a lower number.
 */
export function currentReportItems(items: ItemRow[]): ItemRow[] {
	const reportNumber = (item: ItemRow) =>
		Number(String(parseMeta(item.meta).report).match(/#(\d+)/)?.[1] ?? 0);
	const latest = new Map<string, number>();
	for (const item of items) {
		const date = item.occurred_at?.slice(0, 10) ?? "";
		latest.set(date, Math.max(latest.get(date) ?? 0, reportNumber(item)));
	}
	return items.filter(
		(item) =>
			reportNumber(item) === latest.get(item.occurred_at?.slice(0, 10) ?? ""),
	);
}

/** The next revision of an election's page, or null when it should not move. */
export function nextElectionPage(
	items: ItemRow[],
	previous: ElectionPage | null,
	now: Date,
): ElectionPage | null {
	const current = currentReportItems(items);
	const first = current[0];
	if (!first?.occurred_at) return null;
	const meta = parseMeta(first.meta);
	const report = String(meta.report);
	const status = typeof meta.status === "string" ? meta.status : null;
	const contests = sortContests(current.map(toContest));
	const updatedAt = now.toISOString();

	if (previous) {
		const unchanged =
			previous.status === status &&
			JSON.stringify(previous.contests) === JSON.stringify(contests);
		const ageHours =
			(now.getTime() - new Date(previous.updated_at).getTime()) / 3_600_000;
		if (unchanged || ageHours < MIN_HOURS_BETWEEN_UPDATES) return null;
	}

	return {
		election_date: first.occurred_at.slice(0, 10),
		report,
		status,
		updated_at: updatedAt,
		source_url: first.source_url,
		contests,
		history: [...(previous?.history ?? []), { report, updated_at: updatedAt }],
	};
}

function readPage(path: string): ElectionPage | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ElectionPage;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export function writeElectionPages(
	items: ItemRow[],
	dir: string,
	now: Date,
): string[] {
	const byElection = new Map<string, ItemRow[]>();
	for (const item of items) {
		const date = item.occurred_at?.slice(0, 10);
		if (date) byElection.set(date, [...(byElection.get(date) ?? []), item]);
	}

	const written: string[] = [];
	mkdirSync(dir, { recursive: true });
	for (const [date, group] of byElection) {
		const path = join(dir, `${date}.json`);
		const next = nextElectionPage(group, readPage(path), now);
		if (next) {
			// Renamed into place, so a failed write cannot leave truncated JSON that
			// breaks the site build or loses the update history.
			const temp = `${path}.tmp`;
			writeFileSync(temp, `${JSON.stringify(next, null, "\t")}\n`);
			renameSync(temp, path);
			written.push(date);
		}
	}
	return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const items = queryItems(openDb(), {
		sourceKeys: ["rov-results"],
		itemTypes: ["election_result"],
	});
	const written = writeElectionPages(
		items,
		join(ROOT, "content", "elections"),
		new Date(),
	);
	console.log(
		written.length > 0
			? `election page revised: ${written.join(", ")}`
			: "election page: nothing to revise",
	);
}
