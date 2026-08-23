import assert from "node:assert/strict";
import test from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import nwsAlertsScraper from "./nws-alerts.ts";

const ACTIVE_URL = "https://api.weather.gov/alerts/active?zone=CAZ048";
const RECENT_URL = "https://api.weather.gov/alerts?zone=CAZ048&limit=10";

function feature(id: string, over: Record<string, unknown> = {}) {
	return {
		id: `https://api.weather.gov/alerts/${id}`,
		properties: {
			id,
			event: "Heat Advisory",
			headline: `Heat Advisory ${id}`,
			areaDesc: "San Bernardino and Riverside County Valleys-The Inland Empire",
			severity: "Moderate",
			status: "Actual",
			messageType: "Alert",
			effective: "2026-08-22T13:10:00-07:00",
			ends: "2026-08-25T10:00:00-07:00",
			...over,
		},
	};
}

const feed = (...features: ReturnType<typeof feature>[]) =>
	JSON.stringify({ features });

test("nws-alerts feed collection", async (t) => {
	await t.test(
		"an alert listed by both feeds is stored once, not once per feed",
		async () => {
			// Item identity is (document url, item_type, external_id), and the two
			// feeds are two different document URLs — so every currently-active
			// alert, which both feeds list, used to be inserted twice. 11 such
			// pairs had accumulated in production by 2026-08-23.
			const active = feature("urn:oid:active-and-recent");
			const expired = feature("urn:oid:expired-only", {
				ends: "2026-08-01T20:00:00-07:00",
			});

			const { ctx, items } = fakeScraperContext({
				[ACTIVE_URL]: feed(active),
				[RECENT_URL]: feed(active, expired),
			});

			await nwsAlertsScraper.run(ctx);

			assert.deepEqual(items.map((i) => i.external_id).sort(), [
				"urn:oid:active-and-recent",
				"urn:oid:expired-only",
			]);
		},
	);

	await t.test(
		"the shared alert is attributed to the active feed it came from",
		async () => {
			const shared = feature("urn:oid:shared");
			const { ctx, items } = fakeScraperContext({
				[ACTIVE_URL]: feed(shared),
				[RECENT_URL]: feed(shared),
			});

			await nwsAlertsScraper.run(ctx);

			assert.equal(items.length, 1);
			// The active feed is fetched first, so its document id is the lower of
			// the two the fake context hands out.
			assert.equal(items[0].document_id, 1);
		},
	);

	await t.test(
		"an empty active feed still ingests the recent one",
		async () => {
			const { ctx, items } = fakeScraperContext({
				[ACTIVE_URL]: feed(),
				[RECENT_URL]: feed(feature("urn:oid:recent-only")),
			});

			await nwsAlertsScraper.run(ctx);

			assert.deepEqual(
				items.map((i) => i.external_id),
				["urn:oid:recent-only"],
			);
		},
	);
});
