import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { simpleParser } from "mailparser";
import {
	channelFromSender,
	extractNixlePermalink,
	isChinoRelease,
	isNixleMessage,
	messageToItemDraft,
	nixleLocationField,
} from "./sbsheriff-nixle-mail.ts";

// Fixtures are modeled on REAL messages in the subscribed mailbox, inspected
// 2026-08-17: sender form "SBSD - Headquarters"
// <sbsd---headquarters@emails.nixle.com>, permalink form
// local.nixle.com/alert/<numeric id>/?sub_id=0, subject prefixed with the
// priority ("Advisory Message: ..."). Bodies are paraphrased — real releases
// name private individuals and this repo is not the place to store them.
//
// The previous fixtures encoded the nixle.us/XXXXX shape taken from the web
// channel page, which no email uses; that mismatch is why the source ingested
// nothing for four days. Any future template change should be caught here.

function fieldsOf(eml: Buffer) {
	return simpleParser(eml).then((mail) => ({
		subject: mail.subject ?? null,
		date: mail.date ?? null,
		text: mail.text ?? null,
		html: typeof mail.html === "string" ? mail.html : null,
		from: mail.from?.text ?? null,
		messageId: mail.messageId ?? null,
	}));
}

const CHINO_HILLS_EML = Buffer.from(
	[
		'From: "SBSD - Chino Hills Police Department" <sbsd---chino-hills-police-department@emails.nixle.com>',
		"To: alerts+nixle@example.test",
		"Delivered-To: alerts+nixle@example.test",
		"Message-ID: <alert-1@emails.nixle.com>",
		"Date: Thu, 16 Jul 2026 10:38:00 -0700",
		"Subject: Advisory Message: Traffic collision investigation on Grand Ave",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Dear Nixle User,",
		"",
		"Advisory Message has been issued by the SBSD - Chino Hills Police Department.",
		"",
		"Deputies are investigating a traffic collision on Grand Ave between Peyton",
		"Dr and Boys Republic Dr in Chino Hills.",
		"",
		"View this message on the web at https://local.nixle.com/alert/12598979/?sub_id=0.",
		"",
	].join("\r\n"),
);

// County-wide channel: reaches the same mailbox, has nothing to do with Chino
// Valley, and must NOT be stamped with the Chino Hills channel URL.
const COUNTYWIDE_EML = Buffer.from(
	[
		'From: "SBSD - Headquarters" <sbsd---headquarters@emails.nixle.com>',
		"To: alerts+nixle@example.test",
		"Message-ID: <alert-2@emails.nixle.com>",
		"Date: Fri, 14 Aug 2026 16:25:53 -0700",
		"Subject: Advisory Message: Deputy Involved Shooting Occurs in Mentone",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Dear Nixle User,",
		"",
		"Advisory Message has been issued by the SBSD - Headquarters.",
		"",
		"LOCATION: 300 Block of King Street, Mentone, CA",
		"",
		"View this message on the web at https://local.nixle.com/alert/12601057/?sub_id=0.",
		"",
	].join("\r\n"),
);

const CONFIRMATION_EML = Buffer.from(
	[
		"From: TheNixleTeam@emails.nixle.com",
		"To: alerts+nixle@example.test",
		"Message-ID: <welcome-1@emails.nixle.com>",
		"Date: Wed, 13 Aug 2026 19:16:49 -0700",
		"Subject: Welcome to Nixle",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Thanks for signing up. To learn more, visit https://www.nixle.com/about.html.",
		"",
	].join("\r\n"),
);

describe("nixle permalink extraction", () => {
	test("extracts the local.nixle.com alert permalink and numeric id", () => {
		const p = extractNixlePermalink(
			"view this message on the web at https://local.nixle.com/alert/12601057/?sub_id=0.",
		);
		assert.deepEqual(p, {
			url: "https://local.nixle.com/alert/12601057/",
			code: "12601057",
		});
	});

	test("still accepts the nixle.us short link used on channel pages", () => {
		const p = extractNixlePermalink(
			"view this message on the web at https://nixle.us/HG583 today",
		);
		assert.deepEqual(p, { url: "https://nixle.us/HG583", code: "HG583" });
	});

	test("does not match register, settings, or channel URLs", () => {
		for (const url of [
			"https://local.nixle.com/register/",
			"https://local.nixle.com/accounts/login/",
			"https://local.nixle.com/sbsd---headquarters/",
			"https://local.nixle.com/settings/subscription/10732/x@y.com/abc/",
		]) {
			assert.equal(extractNixlePermalink(`see ${url} and nothing else`), null);
		}
	});

	test("does not match AWS click-tracking wrappers around the permalink", () => {
		// The HTML part wraps every link like this; matching it would store an
		// unresolvable per-recipient tracking URL as the reader-facing source.
		const wrapped =
			"https://67m3dv8f.r.us-east-1.awstrack.me/L0/https:%2F%2Flocal.nixle.com%2Falert%2F12601057%2F%3Fsub_id=0/1/010001a0-x/abc";
		assert.equal(extractNixlePermalink(wrapped), null);
	});
});

describe("channel derivation", () => {
	test("derives the agency channel from the sender address", () => {
		assert.deepEqual(
			channelFromSender(
				'"SBSD - Headquarters" <sbsd---headquarters@emails.nixle.com>',
			),
			{
				slug: "sbsd---headquarters",
				url: "https://local.nixle.com/sbsd---headquarters/",
			},
		);
	});

	test("platform service mail is not an agency channel", () => {
		assert.equal(channelFromSender("TheNixleTeam@emails.nixle.com"), null);
		assert.equal(channelFromSender(null), null);
	});
});

describe("message -> item draft", () => {
	test("a Chino Hills alert maps to a draft with permalink provenance and priority tag", async () => {
		const draft = messageToItemDraft(await fieldsOf(CHINO_HILLS_EML));
		assert.ok(draft);
		assert.equal(draft.external_id, "12598979");
		assert.equal(draft.source_url, "https://local.nixle.com/alert/12598979/");
		assert.equal(
			draft.title,
			"Advisory Message: Traffic collision investigation on Grand Ave",
		);
		assert.equal(draft.meta.priority, "advisory");
		assert.equal(draft.meta.tier, "C");
		assert.equal(draft.meta.chinoRelevant, true);
		assert.equal(
			draft.meta.channel,
			"https://local.nixle.com/sbsd---chino-hills-police-department/",
		);
		assert.ok(draft.occurred_at?.startsWith("2026-07-16T17:38"));
		assert.ok(draft.body.includes("Grand Ave between Peyton"));
	});

	test("a county-wide alert keeps its own channel and is flagged not-Chino", async () => {
		const draft = messageToItemDraft(await fieldsOf(COUNTYWIDE_EML));
		assert.ok(draft);
		assert.equal(draft.external_id, "12601057");
		assert.equal(draft.meta.chinoRelevant, false);
		// Provenance: never stamped with the Chino Hills station channel.
		assert.equal(
			draft.meta.channel,
			"https://local.nixle.com/sbsd---headquarters/",
		);
		assert.equal(draft.meta.channelSlug, "sbsd---headquarters");
	});

	test("fail-closed: a message without a Nixle permalink is never ingested", async () => {
		assert.equal(messageToItemDraft(await fieldsOf(CONFIRMATION_EML)), null);
	});
});

describe("mailbox filter", () => {
	const alias = "alerts+nixle@example.test";

	test("matches on the subscription alias", () => {
		assert.equal(
			isNixleMessage(`to: ${alias}`, "someone@elsewhere", alias),
			true,
		);
	});

	test("matches on a Nixle sender regardless of alias", () => {
		assert.equal(
			isNixleMessage("to: someone@else", '"SBSD" <x@emails.nixle.com>', ""),
			true,
		);
	});

	test("an unset alias must not match every message", () => {
		// The bug this guards: `headerAddrs.includes("")` is true for every
		// string, so an unconfigured alias would turn a targeted ingester into
		// one that reads the whole mailbox.
		assert.equal(
			isNixleMessage("to: bank@example.test", "statements@bank.example", ""),
			false,
		);
		assert.equal(isNixleMessage("", "", ""), false);
	});

	test("unrelated mail does not match even with an alias set", () => {
		assert.equal(
			isNixleMessage("to: someone@else", "statements@bank.example", alias),
			false,
		);
	});
});

describe("isChinoRelease", () => {
	// The W39 regression, from the release that caused it (alert 12668373).
	// Its LOCATION(S) line says Rancho Cucamonga; the only "Chino Hills" in it
	// is a standing paragraph about where the PROGRAMME operates. Scanning the
	// whole body flagged it as local, it published as an alert, and it led the
	// podcast.
	const smashAndGrab = [
		"Dear Nixle User,",
		"",
		"Advisory Message has been issued by the SBSD - Headquarters.",
		"",
		"Six Arrests Made During Targeted Crime Suppression-Operation Smash & Grab",
		"",
		"DATE: September 14, 2026,",
		"",
		"INCIDENT: Targeted Crime Suppression-Operation Smash & Grab",
		"",
		"LOCATION(S): Rancho Cucamonga",
		"",
		"SUMMARY: Between the weeks of August 29, 2026, and September 11, 2026,",
		"investigators conducted a retail theft operation in the area of the",
		"Rancho Cucamonga shopping corridors.",
		"",
		"Operation SMASH & Grab focuses its efforts on the Rancho Cucamonga, Apple",
		"Valley, Hesperia, Victorville, and Chino Hills shopping districts to",
		"disrupt and dismantle these retail store theft crews.",
	].join("\n");

	test("the LOCATION field decides, not a mention anywhere in the prose", () => {
		assert.equal(
			isChinoRelease(
				"Six Arrests Made During Targeted Crime Suppression-Operation Smash & Grab",
				smashAndGrab,
			),
			false,
		);
	});

	test("a release whose LOCATION is Chino is relevant", () => {
		assert.equal(
			isChinoRelease(
				"Advisory Message: Collision",
				smashAndGrab.replace(
					"LOCATION(S): Rancho Cucamonga",
					"LOCATION(S): Chino Hills",
				),
			),
			true,
		);
	});

	test("a location naming both cities is relevant", () => {
		assert.equal(
			isChinoRelease(
				"Advisory Message: Pursuit",
				"LOCATION(S): Chino and Rancho Cucamonga\n\nSUMMARY: A pursuit.",
			),
			true,
		);
	});

	test("a wrapped city list keeps the cities on the continuation line", () => {
		assert.equal(
			isChinoRelease(
				"Advisory Message: Operation",
				smashAndGrab.replace(
					"LOCATION(S): Rancho Cucamonga",
					"LOCATION(S): Rancho Cucamonga, Apple Valley, Hesperia, Victorville,\nChino Hills",
				),
			),
			true,
		);
	});

	test("a wrapped street address keeps the city on the next line", () => {
		assert.equal(
			isChinoRelease(
				"Advisory Message: Collision",
				"LOCATION: 13000 Block of Central Avenue,\nChino, CA\n\nSUMMARY: A collision.",
			),
			true,
		);
	});

	test("the field stops at the next template field, not the boilerplate", () => {
		// No blank line between fields, and the programme paragraph that caused
		// the W39 regression still sits outside the location field.
		assert.equal(
			isChinoRelease(
				"Advisory Message: Operation",
				"LOCATION(S): Rancho Cucamonga\nSUMMARY: Operation SMASH & Grab covers the Chino Hills shopping districts.",
			),
			false,
		);
	});

	test("an empty LOCATION line does not capture the next template field", () => {
		assert.equal(
			nixleLocationField("LOCATION(S):\n\nSUMMARY: A collision in Chino."),
			null,
		);
		// ...so relevance falls back to the whole text, which is the honest read.
		assert.equal(
			isChinoRelease(
				"Advisory",
				"LOCATION(S):\n\nSUMMARY: A collision in Chino.",
			),
			true,
		);
	});

	test("a wrapped location keeps the city on the continuation line", () => {
		assert.equal(
			nixleLocationField(
				"LOCATION(S): 16150 Pomona Rincon Road,\nChino Hills\n\nSUMMARY: x",
			),
			"16150 Pomona Rincon Road, Chino Hills",
		);
	});

	test("a free-form release with no template falls back to the whole text", () => {
		assert.equal(
			isChinoRelease(
				"Advisory Message: Road closure",
				"SUMMARY: Central Avenue in Chino is closed this evening.",
			),
			true,
		);
		assert.equal(
			isChinoRelease(
				"Advisory Message: Road closure",
				"SUMMARY: Foothill Boulevard in Upland is closed this evening.",
			),
			false,
		);
	});
});
