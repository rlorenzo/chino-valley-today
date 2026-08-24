import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import scraper, {
	dateCorroboration,
	extractMinutesItems,
	parseFilename,
} from "./chinohills-minutes.ts";

// A real, parseable PDF built in-process. The alternative was checking a
// binary fixture into the repo, or reading one out of data/raw — which is
// gitignored, so those tests would pass on this machine and fail in CI.
function makePdf(lines: string[]): Buffer {
	const esc = (s: string) => s.replace(/([\\()])/g, "\\$1");
	const content = `BT /F1 12 Tf 72 720 Td 14 TL\n${lines
		.map((l) => `(${esc(l)}) Tj T*`)
		.join("\n")}\nET`;
	const objs = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[3 0 R]/Count 1>>",
		"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
		`<</Length ${content.length}>>\nstream\n${content}\nendstream`,
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

const tmpDirs: string[] = [];
function dropWith(files: Record<string, Buffer | string>): string {
	const dir = mkdtempSync(join(tmpdir(), "cvt-minutes-"));
	tmpDirs.push(dir);
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(
			join(dir, name),
			typeof body === "string" ? Buffer.from(body, "utf8") : body,
		);
	}
	return dir;
}

async function runOn(dir: string) {
	const fake = fakeScraperContext({});
	const prev = process.env.CVT_MINUTES_DROP_DIR;
	process.env.CVT_MINUTES_DROP_DIR = dir;
	try {
		await scraper.run(fake.ctx);
		return { fake, threw: null as Error | null };
	} catch (err) {
		return { fake, threw: err as Error };
	} finally {
		if (prev === undefined) delete process.env.CVT_MINUTES_DROP_DIR;
		else process.env.CVT_MINUTES_DROP_DIR = prev;
	}
}

after(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const COUNCIL_MINUTES = [
	"CITY OF CHINO HILLS",
	"CITY COUNCIL MINUTES",
	"August 11, 2026",
	"1. CALL TO ORDER",
	"The meeting was called to order at 7:00 p.m.",
	"2. CONSENT CALENDAR",
	"Approved as submitted.",
	"3. PUBLIC HEARING",
	"Villa Borba tract map extension.",
];

describe("parseFilename", () => {
	it("parses a well-formed name into body, url and date", () => {
		const p = parseFilename("chinohills-city-council-2026-08-11-minutes.pdf");
		assert.ok(typeof p !== "string", `expected a parse, got: ${p}`);
		assert.equal(p.bodySlug, "city-council");
		assert.equal(p.bodyName, "City Council");
		assert.equal(p.date, "2026-08-11");
		assert.match(p.minutesUrl, /startid=66925/);
	});

	it("gives each body its own minutes folder url", () => {
		const a = parseFilename(
			"chinohills-planning-commission-2026-08-11-minutes.pdf",
		);
		const b = parseFilename(
			"chinohills-public-art-committee-2026-08-11-minutes.pdf",
		);
		assert.ok(typeof a !== "string" && typeof b !== "string");
		assert.notEqual(a.minutesUrl, b.minutesUrl);
		assert.match(a.minutesUrl, /id=3943/);
		assert.match(b.minutesUrl, /id=348679/);
	});

	it("rejects an unknown body rather than inventing a url for it", () => {
		const p = parseFilename("chinohills-water-board-2026-08-11-minutes.pdf");
		assert.equal(typeof p, "string");
		assert.match(p as string, /unknown body "water-board"/);
	});

	it("rejects a date the calendar does not have", () => {
		// Would otherwise reach occurred_at and sort wrong forever.
		const p = parseFilename("chinohills-city-council-2026-02-31-minutes.pdf");
		assert.equal(typeof p, "string");
		assert.match(p as string, /not a real calendar date/);
	});

	it("rejects a name that is not the agreed shape", () => {
		for (const bad of [
			"minutes.pdf",
			"chinohills-city-council-minutes.pdf",
			"chinohills-city-council-08-11-2026-minutes.pdf",
			"chinohills-city-council-2026-08-11-agenda.pdf",
		]) {
			assert.equal(typeof parseFilename(bad), "string", `should reject ${bad}`);
		}
	});
});

describe("dateCorroboration", () => {
	it("accepts text whose date matches the filename", () => {
		const r = dateCorroboration(
			"CITY COUNCIL MINUTES August 11, 2026",
			"2026-08-11",
		);
		assert.equal(r.ok, true);
		assert.ok(r.found.includes("2026-08-11"));
	});

	it("accepts the day-first long form", () => {
		const r = dateCorroboration("Minutes of 11 August 2026", "2026-08-11");
		assert.equal(r.ok, true);
	});

	it("rejects text that names a different meeting date", () => {
		// The failure that matters: a mis-renamed file filing minutes under the
		// wrong meeting is worse than having no minutes at all.
		const r = dateCorroboration(
			"CITY COUNCIL MINUTES August 11, 2026",
			"2026-09-08",
		);
		assert.equal(r.ok, false);
		assert.deepEqual(r.found, ["2026-08-11"]);
	});

	it("passes when no date can be read at all", () => {
		// Scanned/image-only minutes OCR to nothing; absence is not contradiction.
		const r = dateCorroboration("\f\f", "2026-08-11");
		assert.equal(r.ok, true);
		assert.deepEqual(r.found, []);
	});
});

describe("extractMinutesItems", () => {
	it("splits numbered items and keeps their order", () => {
		const items = extractMinutesItems(
			"1. CALL TO ORDER\nCalled at 7pm.\n2. CONSENT CALENDAR\nApproved.\n3. ADJOURN\nAt 9pm.",
		);
		assert.deepEqual(
			items.map((i) => i.num),
			[1, 2, 3],
		);
		assert.equal(items[0].title, "CALL TO ORDER");
		assert.match(items[1].body, /Approved/);
	});

	it("does not open a new item for a numbered list inside an item", () => {
		// A motion's numbered conditions restart at 1. An earlier "keep any
		// increasing number" rule turned the nested "2." into a spurious
		// top-level item, which is the failure this rule exists to prevent.
		const items = extractMinutesItems(
			"1. FIRST\nConditions:\n1. one\n2. two\n5. FIFTH\nBody.",
		);
		assert.deepEqual(
			items.map((i) => i.num),
			[1],
		);
	});

	it("stops at a gap rather than guessing across it", () => {
		// Under-extraction by design: a missing item is a gap in the breakdown,
		// a fabricated one is a false entry in the record. The document is
		// archived and linked either way.
		const items = extractMinutesItems("1. ONE\na\n2. TWO\nb\n7. SEVEN\nc");
		assert.deepEqual(
			items.map((i) => i.num),
			[1, 2],
		);
	});

	it("ignores numbering that does not start at 1", () => {
		assert.deepEqual(extractMinutesItems("3. THREE\na\n4. FOUR\nb"), []);
	});

	it("returns nothing for text with no numbered items", () => {
		assert.deepEqual(extractMinutesItems("No numbering here at all."), []);
	});
});

describe("chinohills-minutes run", () => {
	it("ingests a well-formed drop and links items to the folder url", async () => {
		const dir = dropWith({
			"chinohills-city-council-2026-08-11-minutes.pdf":
				makePdf(COUNCIL_MINUTES),
		});
		const { fake, threw } = await runOn(dir);
		assert.equal(threw, null, `unexpected throw: ${threw?.message}`);

		assert.equal(fake.ingested.length, 1);
		const doc = fake.ingested[0].meta;
		assert.equal(doc.docType, "minutes");
		assert.equal(doc.meetingDate, "2026-08-11");
		assert.match(doc.url, /publicportal\.chinohills\.org/);
		assert.match(doc.title as string, /City Council/);
		// The archived bytes are the PDF itself, not extracted text.
		assert.equal(fake.ingested[0].bytes.subarray(0, 5).toString(), "%PDF-");

		assert.equal(fake.items.length, 3);
		assert.equal(fake.items[0].item_type, "agenda_item");
		assert.equal(fake.items[0].external_id, "city-council-2026-08-11-1");
		assert.equal(fake.items[0].occurred_at, "2026-08-11");
		assert.match(fake.items[0].source_url, /startid=66925/);
	});

	it("never requests anything over the network", async () => {
		// The whole reason this scraper exists. A future edit that adds a fetch
		// to the Laserfiche host should fail here.
		const dir = dropWith({
			"chinohills-city-council-2026-08-11-minutes.pdf":
				makePdf(COUNCIL_MINUTES),
		});
		const { fake } = await runOn(dir);
		assert.deepEqual(fake.requested, []);
		assert.deepEqual(fake.documents, []);
	});

	it("fails the run when a file is rejected, rather than reporting success", async () => {
		// The chinohills-swagit lesson: noting a problem and returning normally
		// records status 'success' with 0 items and hides an outage indefinitely.
		const dir = dropWith({
			"chinohills-city-council-2026-08-11-minutes.pdf":
				makePdf(COUNCIL_MINUTES),
			"not-a-known-name.pdf": makePdf(["whatever"]),
		});
		const { fake, threw } = await runOn(dir);
		assert.ok(threw, "a rejected file must fail the run");
		assert.match(threw.message, /1 file\(s\) rejected/);
		// The good file is still ingested; one bad name does not block the rest.
		assert.equal(fake.ingested.length, 1);
	});

	it("rejects an HTML error page saved with a .pdf name", async () => {
		const dir = dropWith({
			"chinohills-city-council-2026-08-11-minutes.pdf":
				"<html><body>Session expired</body></html>",
		});
		const { fake, threw } = await runOn(dir);
		assert.ok(threw);
		assert.match(threw.message, /not a PDF/);
		assert.equal(fake.ingested.length, 0);
	});

	it("refuses a file whose text contradicts its filename date", async () => {
		const dir = dropWith({
			// Text says August 11; the name claims September 8.
			"chinohills-city-council-2026-09-08-minutes.pdf":
				makePdf(COUNCIL_MINUTES),
		});
		const { fake, threw } = await runOn(dir);
		assert.ok(threw);
		assert.match(
			threw.message,
			/refusing to file minutes under the wrong meeting/,
		);
		assert.equal(fake.ingested.length, 0);
	});

	it("treats an empty drop directory as healthy, not as a failure", async () => {
		const { fake, threw } = await runOn(dropWith({}));
		assert.equal(threw, null);
		assert.equal(fake.ingested.length, 0);
		assert.ok(fake.notes.some((n) => /is empty/.test(n)));
	});

	it("treats a missing drop directory as healthy and says where it looked", async () => {
		const dir = join(tmpdir(), "cvt-minutes-does-not-exist-12345");
		rmSync(dir, { recursive: true, force: true });
		const { fake, threw } = await runOn(dir);
		assert.equal(threw, null);
		assert.ok(fake.notes.some((n) => n.includes(dir)));
	});

	it("skips a file whose content hash is already held, without parsing it", async () => {
		const dir = dropWith({
			"chinohills-city-council-2026-08-11-minutes.pdf":
				makePdf(COUNCIL_MINUTES),
		});
		const fake = fakeScraperContext({});
		// Stand in for a database that already holds this document.
		(fake.ctx as { db: unknown }).db = {
			raw: { prepare: () => ({ get: () => ({ id: 7 }) }) },
		} as unknown as typeof fake.ctx.db;
		const prev = process.env.CVT_MINUTES_DROP_DIR;
		process.env.CVT_MINUTES_DROP_DIR = dir;
		try {
			await scraper.run(fake.ctx);
		} finally {
			if (prev === undefined) delete process.env.CVT_MINUTES_DROP_DIR;
			else process.env.CVT_MINUTES_DROP_DIR = prev;
		}
		assert.equal(fake.ingested.length, 0);
		assert.equal(fake.items.length, 0);
		assert.ok(fake.notes.some((n) => /1 already held/.test(n)));
	});

	it("archives a minutes PDF that has no numbered items, and says so", async () => {
		const dir = dropWith({
			"chinohills-tres-hermanos-jpa-2026-08-11-minutes.pdf": makePdf([
				"TRES HERMANOS JPA",
				"August 11, 2026",
				"No business was conducted.",
			]),
		});
		const { fake, threw } = await runOn(dir);
		assert.equal(threw, null);
		assert.equal(fake.ingested.length, 1);
		assert.equal(fake.items.length, 0);
		assert.ok(fake.notes.some((n) => /no numbered items were parsed/.test(n)));
	});
});
