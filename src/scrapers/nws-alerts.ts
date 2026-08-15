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

function storeAlerts(
	ctx: Parameters<ScraperDef["run"]>[0],
	documentId: number,
	features: AlertFeature[],
) {
	for (const f of features) {
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
		storeAlerts(ctx, active.documentId, activeFeatures);

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
		ctx.note(
			`${recentFeatures.length} recent alert(s) (incl. expired) stored for sample purposes`,
		);
		storeAlerts(ctx, recent.documentId, recentFeatures);

		ctx.note(
			"api.weather.gov requires a User-Agent header; supports ETag (If-None-Match honored).",
		);
	},
};

export default scraper;
