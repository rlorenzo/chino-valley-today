// San Bernardino County Registrar of Voters election results. One public page
// holds every contest in the current election, and the same URL is reused for
// the next one, so each item's identity leads with the election date. Re-reads
// update a contest in place as the registrar posts new counts. An all-county
// page with no contest for us is the normal state between elections.
import * as cheerio from "cheerio";
import type { ScraperDef } from "./types.ts";

const RESULTS_URL = "https://results.rov.sbcounty.gov/";
// Chino Basin Water Conservation District is a different body whose divisions
// are not specific to our two cities, so "Chino" alone is too broad.
const LOCAL_CONTEST_RE = /^(?:City of Chino(?: Hills)? |Chino Valley )/;

export interface RovChoice {
	name: string;
	votes: number;
	percent: string;
}

export interface RovContest {
	name: string;
	choices: RovChoice[];
}

export interface RovResults {
	electionDate: string;
	report: string;
	// The registrar's own label, such as "Final Unofficial Election Night
	// Results". Null when the page omits it.
	status: string | null;
	contests: RovContest[];
}

/** Returns null when the page no longer has the shape this was written for. */
export function parseRovResults(html: string): RovResults | null {
	const $ = cheerio.load(html);
	const dateMatch = $("title")
		.text()
		.match(/(\d{2})\/(\d{2})\/(\d{4})/);
	const report = $("h2")
		.text()
		.match(/Summary Report #\d+/)?.[0];
	if (!dateMatch || !report) return null;

	const contests: RovContest[] = [];
	let unreadable = false;
	$('table[id^="electionResultsTable"]').each((_, table) => {
		const name = $(table)
			.find("h2")
			.first()
			.text()
			.replace(/\(Vote for\s+\d+\)/, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!LOCAL_CONTEST_RE.test(name)) return;

		const choices: RovChoice[] = [];
		$(table)
			.find('table[id^="electionContests"]')
			.not('[id^="electionContestsUnresolved"]')
			.find("tbody tr")
			.each((_, row) => {
				const cells = $(row).find("td");
				// The "Total Votes" row spans its first two columns.
				if (cells.length !== 4) return;
				choices.push({
					name: cells.eq(0).text().trim(),
					votes: Number(cells.eq(2).text().replace(/,/g, "")),
					percent: cells.eq(3).text().trim(),
				});
			});
		// A contest with no rows means the markup moved. Storing it would replace
		// good counts with nothing.
		if (choices.length === 0) unreadable = true;
		choices.sort((a, b) => b.votes - a.votes);
		contests.push({ name, choices });
	});

	if (unreadable) return null;

	return {
		electionDate: `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`,
		report,
		status: $("#election-results-message").text().trim() || null,
		contests,
	};
}

const scraper: ScraperDef = {
	key: "rov-results",
	name: "San Bernardino County Registrar of Voters (election results)",
	baseUrl: RESULTS_URL,
	method: "html",
	async run(ctx) {
		const doc = await ctx.fetchDocument(RESULTS_URL, {
			docType: "election_results",
			title: "San Bernardino County election results",
		});
		const results = parseRovResults(doc.body.toString("utf8"));
		if (!results) throw new Error("results page shape not recognized");

		for (const contest of results.contests) {
			ctx.insertItem({
				document_id: doc.documentId,
				source_url: RESULTS_URL,
				item_type: "election_result",
				external_id: `${results.electionDate}:${contest.name}`,
				title: contest.name,
				body: contest.choices
					.map(
						(c) =>
							`${c.name} ${c.votes.toLocaleString("en-US")} (${c.percent})`,
					)
					.join(", "),
				occurred_at: `${results.electionDate}T00:00:00.000Z`,
				meta: {
					report: results.report,
					status: results.status,
					choices: contest.choices,
				},
			});
		}
		ctx.note(
			`${results.report}: ${results.contests.length} local contest(s). A 0-contest run is normal between elections.`,
		);
	},
};

export default scraper;
