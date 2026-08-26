import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
	capAlertTitle,
	capBlocks,
	formatCapInstant,
	parseCapFeed,
} from "../../site/src/lib/cap.ts";

// Shapes copied from a real api.weather.gov response archived on 2026-08-13
// (data/raw/7c/7caf5e24…json), trimmed to the fields the page reads. The
// wrapping and the `* WHAT...` convention are NWS's, not invented here: they
// are the whole reason capBlocks exists.
const FEED = JSON.stringify({
	type: "FeatureCollection",
	features: [
		{
			id: "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.aaa.002.1",
			properties: {
				"@id":
					"https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.aaa.002.1",
				id: "urn:oid:2.49.0.1.840.0.aaa.002.1",
				areaDesc:
					"San Bernardino and Riverside County Valleys-The Inland Empire",
				sent: "2026-08-09T12:53:00-07:00",
				effective: "2026-08-09T12:53:00-07:00",
				ends: "2026-08-09T20:00:00-07:00",
				expires: "2026-08-09T21:00:00-07:00",
				status: "Actual",
				messageType: "Update",
				severity: "Moderate",
				certainty: "Likely",
				urgency: "Expected",
				event: "Heat Advisory",
				senderName: "NWS San Diego CA",
				headline: "Heat Advisory issued August 9 at 12:53PM PDT",
				description:
					"* WHAT...Temperatures up to 103.\n\n* WHERE...San Bernardino and Riverside County Valleys-The Inland\nEmpire.\n\n* WHEN...Until 8 PM PDT this evening.",
				instruction:
					"Drink plenty of fluids, stay in an air-conditioned room, stay out of\nthe sun.",
				parameters: {
					NWSheadline: ["HEAT ADVISORY REMAINS IN EFFECT UNTIL 8 PM PDT"],
					VTEC: ["/O.CON.KSGX.HT.Y.0008.000000T0000Z-260810T0300Z/"],
				},
			},
		},
	],
});

describe("parseCapFeed", () => {
	test("reads the fields the archive page renders", () => {
		const alerts = parseCapFeed(FEED);
		assert.ok(alerts);
		assert.equal(alerts.length, 1);
		const a = alerts[0];
		assert.equal(a.id, "urn:oid:2.49.0.1.840.0.aaa.002.1");
		assert.equal(a.event, "Heat Advisory");
		assert.equal(a.senderName, "NWS San Diego CA");
		assert.equal(a.messageType, "Update");
		assert.equal(
			a.originalUrl,
			"https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.aaa.002.1",
		);
	});

	// items.meta keeps event, severity, urgency, areaDesc, status, messageType,
	// effective and ends — no description and no instruction. Those two are the
	// alert's actual content, they live only in the archived bytes, and reading
	// them from there is the reason the page reads the archive rather than the
	// database.
	test("recovers the description and instruction the item row does not store", () => {
		const a = parseCapFeed(FEED)?.[0];
		assert.ok(a?.description?.includes("Temperatures up to 103"));
		assert.ok(a?.instruction?.includes("Drink plenty of fluids"));
	});

	// parameters.NWSheadline states an upgrade, extension or expiry in plain
	// words, and is the single most useful line in most records.
	test("lifts NWSheadline out of the parameters map", () => {
		assert.equal(
			parseCapFeed(FEED)?.[0].nwsHeadline,
			"HEAT ADVISORY REMAINS IN EFFECT UNTIL 8 PM PDT",
		);
	});

	test("a feed with no alerts is empty, not absent", () => {
		assert.deepEqual(
			parseCapFeed('{"type":"FeatureCollection","features":[]}'),
			[],
		);
	});

	// Null and [] mean different things to the page: "these bytes are not a CAP
	// feed, say so" versus "this is a CAP feed and nothing was in effect".
	test("bytes that are not a CAP feed come back null", () => {
		assert.equal(parseCapFeed("<html>not json</html>"), null);
		assert.equal(parseCapFeed('{"features":"nope"}'), null);
	});

	test("a record with no id is skipped rather than rendered unanchorable", () => {
		const feed = JSON.stringify({
			features: [{ properties: { event: "Heat Advisory" } }],
		});
		assert.deepEqual(parseCapFeed(feed), []);
	});
});

describe("capBlocks", () => {
	test("unwraps teletype line breaks and keeps real paragraph breaks", () => {
		const blocks = capBlocks(
			"At 1248 PM PDT, Doppler radar was tracking a strong thunderstorm near\nHwy 79.\n\nHAZARD...Wind gusts up to 50 mph.",
		);
		assert.deepEqual(blocks, [
			{
				kind: "para",
				text: "At 1248 PM PDT, Doppler radar was tracking a strong thunderstorm near Hwy 79.",
			},
			{ kind: "para", text: "HAZARD...Wind gusts up to 50 mph." },
		]);
	});

	test("consecutive starred paragraphs become one list", () => {
		const blocks = capBlocks(parseCapFeed(FEED)?.[0].description ?? null);
		assert.deepEqual(blocks, [
			{
				kind: "list",
				items: [
					"WHAT...Temperatures up to 103.",
					"WHERE...San Bernardino and Riverside County Valleys-The Inland Empire.",
					"WHEN...Until 8 PM PDT this evening.",
				],
			},
		]);
	});

	test("no text is no blocks", () => {
		assert.deepEqual(capBlocks(null), []);
		assert.deepEqual(capBlocks("   "), []);
	});
});

describe("capAlertTitle", () => {
	// A feed carries an advisory's issuance, its updates and its cancellation
	// under one event name. Titling all three "Heat Advisory" is the cancelled-
	// alert-rendered-as-active failure one layer down.
	test("qualifies the event by what this issuance did to it", () => {
		const base = parseCapFeed(FEED)?.[0];
		assert.ok(base);
		assert.equal(capAlertTitle(base), "Heat Advisory — Update");
		assert.equal(
			capAlertTitle({ ...base, messageType: "Cancel" }),
			"Heat Advisory — Cancel",
		);
		// "Alert" is the plain first issuance and adds nothing to the name.
		assert.equal(
			capAlertTitle({ ...base, messageType: "Alert" }),
			"Heat Advisory",
		);
		assert.equal(
			capAlertTitle({ ...base, messageType: null }),
			"Heat Advisory",
		);
	});
});

describe("formatCapInstant", () => {
	test("renders a CAP stamp in Chino's own zone", () => {
		assert.equal(
			formatCapInstant("2026-08-09T12:53:00-07:00"),
			"Sun, Aug 9, 2026, 12:53 PM PDT",
		);
	});

	// A UTC stamp is what documents.fetched_at holds, and it has to land in
	// Pacific too or the page tells a reader the archive was taken on the wrong
	// day.
	test("converts a UTC stamp rather than printing it as-is", () => {
		assert.equal(
			formatCapInstant("2026-08-13T19:20:21.700Z"),
			"Thu, Aug 13, 2026, 12:20 PM PDT",
		);
	});

	test("an unparseable value prints as itself rather than as a made-up date", () => {
		assert.equal(formatCapInstant("whenever"), "whenever");
		assert.equal(formatCapInstant(null), null);
	});
});
