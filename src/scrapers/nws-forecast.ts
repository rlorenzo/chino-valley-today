// Phase 4 Task 4.1 — NWS gridpoint daily forecast, the daily brief's "always
// have something" anchor. Extends the nws-alerts integration to the forecast
// endpoints on the same documented API.
//
// Gridpoints verified live via /points (2026-08-17): Chino (33.99,-117.69) ->
// SGX/47,73; Chino Hills (33.95,-117.73) -> SGX/45,71. Adjacent cells, but both
// are ingested so each city's brief line quotes its own forecast; items are
// tagged by city in meta.
//
// Forecast periods churn on every NWS update; insertItem's in-place update on
// (document url, item_type, external_id) means re-runs refresh a period's body
// rather than duplicating it. external_id embeds gridpoint + period start.
import { resolveDocumentId } from "./document-linkage.ts";
import type { NewItemInput, ScraperDef } from "./types.ts";

interface ForecastPeriod {
	number: number;
	name?: string; // "Today", "Tonight", "Monday", ...
	startTime?: string; // ISO with offset
	endTime?: string;
	isDaytime?: boolean;
	temperature?: number;
	temperatureUnit?: string;
	windSpeed?: string;
	windDirection?: string;
	shortForecast?: string;
	detailedForecast?: string;
	probabilityOfPrecipitation?: { value?: number | null };
}

const CITIES = [
	{
		city: "Chino",
		grid: "SGX/47,73",
		// Human-readable forecast page for the same point — the reader-clickable
		// citation target (the API URL serves JSON, not a readable page).
		readerUrl:
			"https://forecast.weather.gov/MapClick.php?lat=33.99&lon=-117.69",
	},
	{
		city: "Chino Hills",
		grid: "SGX/45,71",
		readerUrl:
			"https://forecast.weather.gov/MapClick.php?lat=33.95&lon=-117.73",
	},
] as const;

// Invalid Date throws from toISOString(); one malformed API timestamp must
// not abort the whole run (same guard discipline as tribeUtcToIso).
function toIsoOrNull(s: string | undefined): string | null {
	if (!s) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Pure mapping, exported for tests.
export function mapForecastPeriod(
	p: ForecastPeriod,
	city: string,
	grid: string,
	readerUrl: string,
): Omit<NewItemInput, "document_id"> | null {
	const startIso = toIsoOrNull(p.startTime);
	if (!startIso) return null;
	return {
		source_url: readerUrl,
		item_type: "forecast_period",
		external_id: `${grid}:${startIso}`,
		title: `${city} — ${p.name ?? "period"}: ${p.shortForecast ?? "forecast"}`,
		body: p.detailedForecast ?? null,
		occurred_at: startIso,
		meta: {
			city,
			grid,
			periodName: p.name,
			isDaytime: p.isDaytime ?? null,
			temperature: p.temperature ?? null,
			temperatureUnit: p.temperatureUnit ?? null,
			windSpeed: p.windSpeed ?? null,
			windDirection: p.windDirection ?? null,
			shortForecast: p.shortForecast ?? null,
			probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
			endTime: toIsoOrNull(p.endTime),
		},
	};
}

const scraper: ScraperDef = {
	key: "nws-forecast",
	name: "NWS Daily Forecast (Chino & Chino Hills gridpoints)",
	baseUrl: "https://api.weather.gov",
	method: "api",
	async run(ctx) {
		for (const c of CITIES) {
			// Same skipRobots justification as nws-alerts: api.weather.gov's blanket
			// Disallow targets crawlers; the API is documented for programmatic use
			// with a contact-bearing User-Agent, which politeFetch sends.
			const doc = await ctx.fetchDocument(
				`https://api.weather.gov/gridpoints/${c.grid}/forecast`,
				{
					docType: "forecast",
					title: `NWS forecast — ${c.city} (${c.grid})`,
					skipRobots: true,
				},
			);
			const parsed = JSON.parse(doc.body.toString("utf8")) as {
				properties?: { periods?: ForecastPeriod[]; updateTime?: string };
			};
			const periods = parsed.properties?.periods ?? [];
			let stored = 0;
			for (const p of periods) {
				const item = mapForecastPeriod(p, c.city, c.grid, c.readerUrl);
				if (!item) continue;
				ctx.insertItem({
					...item,
					document_id: resolveDocumentId(
						ctx,
						doc.documentId,
						item.external_id,
						item.item_type,
					),
				});
				stored++;
			}
			ctx.note(
				`${c.city} (${c.grid}): ${stored} forecast period(s) stored ` +
					`(API updateTime ${parsed.properties?.updateTime ?? "unknown"}). ` +
					`Re-runs update periods in place via (document url, item_type, external_id) identity.`,
			);
		}
		ctx.note(
			"source_url points at forecast.weather.gov's MapClick page per city (reader-facing), not the JSON API URL; the API URL is recoverable from meta.grid.",
		);
	},
};

export default scraper;
