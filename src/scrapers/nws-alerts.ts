// Task 0.7 — NWS alerts. Reference implementation for the scraper contract.
// Zone verified via api.weather.gov/points/33.99,-117.69 and /points/33.95,-117.73:
// Chino AND Chino Hills both sit in forecast zone CAZ048 (San Bernardino/Riverside
// valleys); PLAN.md's CAZ560 guess was wrong. County zone CAC071.
import type { ScraperDef } from "./types.ts";

const ZONE = "CAZ048";

interface AlertFeature {
	id: string;
	properties: {
		id?: string;
		event?: string;
		headline?: string;
		description?: string;
		severity?: string;
		urgency?: string;
		areaDesc?: string;
		onset?: string;
		effective?: string;
		ends?: string;
		expires?: string;
		status?: string;
		messageType?: string;
	};
}

interface AlertSighting {
	feature: AlertFeature;
	documentId: number;
}

/**
 * One entry per alert, keyed on the id the feed gives it. An alert that is
 * currently active is listed by BOTH the active feed and the recent feed, and
 * item identity is (document url, item_type, external_id) — two different
 * document URLs, so storing each feed on its own stored every active alert
 * twice, once per feed. Earlier sightings win, so an active alert is attributed
 * to the active feed it came from.
 */
function collectAlerts(
	seen: Map<string, AlertSighting>,
	features: AlertFeature[],
	documentId: number,
): void {
	for (const feature of features) {
		const id = feature.properties.id ?? feature.id;
		if (!seen.has(id)) seen.set(id, { feature, documentId });
	}
}

function storeAlerts(
	ctx: Parameters<ScraperDef["run"]>[0],
	sightings: Iterable<AlertSighting>,
) {
	for (const { feature: f, documentId } of sightings) {
		const p = f.properties;
		ctx.insertItem({
			document_id: documentId,
			source_url: f.id, // alert @id URL (stable API permalink)
			item_type: "alert",
			external_id: p.id ?? f.id,
			title: p.headline ?? p.event ?? "NWS alert",
			body: p.description ?? null,
			meta: {
				event: p.event,
				severity: p.severity,
				urgency: p.urgency,
				areaDesc: p.areaDesc,
				status: p.status,
				messageType: p.messageType,
				effective: p.effective,
				ends: p.ends ?? p.expires,
			},
			occurred_at: p.onset ?? p.effective ?? null,
		});
	}
}

const scraper: ScraperDef = {
	key: "nws-alerts",
	name: "NWS Alerts (Chino Valley, zone CAZ048)",
	baseUrl: "https://api.weather.gov",
	method: "api",
	async run(ctx) {
		// api.weather.gov robots.txt is a blanket Disallow aimed at crawlers; the
		// API itself is documented for programmatic use (UA with contact required,
		// which politeFetch sends). skipRobots is justified here.
		const active = await ctx.fetchDocument(
			`https://api.weather.gov/alerts/active?zone=${ZONE}`,
			{
				docType: "alert",
				title: `Active NWS alerts for ${ZONE}`,
				skipRobots: true,
			},
		);
		const activeFeed = JSON.parse(active.body.toString("utf8")) as {
			features?: AlertFeature[];
		};
		const activeFeatures = activeFeed.features ?? [];
		ctx.note(`${activeFeatures.length} active alert(s) for zone ${ZONE}`);
		const seen = new Map<string, AlertSighting>();
		collectAlerts(seen, activeFeatures, active.documentId);

		// Also pull recent (incl. expired) alerts so the POC has sample items even
		// on a quiet weather day.
		const recent = await ctx.fetchDocument(
			`https://api.weather.gov/alerts?zone=${ZONE}&limit=10`,
			{
				docType: "alert",
				title: `Recent NWS alerts for ${ZONE}`,
				skipRobots: true,
			},
		);
		const recentFeed = JSON.parse(recent.body.toString("utf8")) as {
			features?: AlertFeature[];
		};
		const recentFeatures = recentFeed.features ?? [];
		collectAlerts(seen, recentFeatures, recent.documentId);
		ctx.note(
			`${recentFeatures.length} recent alert(s) (incl. expired); ${seen.size} distinct alert(s) across both feeds`,
		);
		storeAlerts(ctx, seen.values());

		ctx.note(
			"api.weather.gov requires a User-Agent header; supports ETag (If-None-Match honored).",
		);
	},
};

export default scraper;
