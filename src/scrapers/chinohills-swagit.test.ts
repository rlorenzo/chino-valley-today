// These cover one property: this scraper cannot fail quietly.
//
// It ingested nothing from 2026-08-19 onward — Swagit's edge 403s the
// droplet's IP — and recorded `success` with 0 items every single day, because
// run-one.ts reads a run's status from whether run() threw and this scraper
// noted its failures and returned normally. Six days, every watchdog green.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import scraper from "./chinohills-swagit.ts";

const HOST = "https://chinohillsca.new.swagit.com";
const LISTING = `${HOST}/views/default/`;
const VIDEO = `${HOST}/videos/1234`;

const listingHtml = (rows: string) =>
	`<html><body><table><tbody>${rows}</tbody></table></body></html>`;
const row = (id: string, date: string) =>
	`<tr><td><a href="/videos/${id}">City Council Meeting</a></td><td>${date}</td></tr>`;

describe("chinohills-swagit failure paths", () => {
	it("fails the run when the listing is refused", async () => {
		// The production failure, exactly: HTTP 403 from the vendor's edge.
		const { ctx, items } = fakeScraperContext({ [LISTING]: { status: 403 } });

		await assert.rejects(() => scraper.run(ctx), /HTTP 403/);
		assert.deepEqual(items, []);
	});

	it("fails the run when the listing parses to no rows", async () => {
		// The listing is an archive of past meetings. It does not empty because a
		// Council meeting did not happen, so zero rows means the markup moved.
		const { ctx } = fakeScraperContext({
			[LISTING]: listingHtml("<tr><td>nothing here</td></tr>"),
		});

		await assert.rejects(
			() => scraper.run(ctx),
			/No parsable\/dated video rows/,
		);
	});

	it("fails the run when no candidate meeting carries a transcript", async () => {
		// One meeting without a transcript yet is ordinary; every candidate
		// lacking one means the transcript markup moved or the pages are not
		// reaching us.
		const { ctx } = fakeScraperContext({
			[LISTING]: listingHtml(row("1234", "Aug 11, 2026")),
			[VIDEO]:
				"<html><title>Aug 11, 2026 City Council</title><body></body></html>",
		});

		await assert.rejects(
			() => scraper.run(ctx),
			/none had a machine transcript/,
		);
	});
});
