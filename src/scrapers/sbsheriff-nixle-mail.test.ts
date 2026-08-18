import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { simpleParser } from "mailparser";
import {
	channelFromSender,
	extractNixlePermalink,
	messageToItemDraft,
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
		"To: chinovalleytoday+nixle@gmail.com",
		"Delivered-To: chinovalleytoday+nixle@gmail.com",
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
		"To: chinovalleytoday+nixle@gmail.com",
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
		"To: chinovalleytoday+nixle@gmail.com",
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
