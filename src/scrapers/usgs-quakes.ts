// USGS earthquakes near the Chino Valley. Raised 2026-09-02 after a M3.4 near
// Ontario at 05:37 PT reached every phone in town and nothing on this site:
// the registry had no seismic source at all.
//
// USGS FDSN event web service, format=geojson. Public domain (a US Government
// work), no auth, no key, and earthquake.usgs.gov serves no robots.txt at all
// (404, checked 2026-09-02) — so unlike api.weather.gov this needs no
// skipRobots justification. Every event carries a real reader-facing permalink
// at earthquake.usgs.gov/earthquakes/eventpage/<id>, which is what we cite.
//
// County-wide-by-nature source, handled like sbcfire-news: everything in the
// search ring is ingested, Chino Valley relevance is FLAGGED in
// meta.chinoRelevant, and the daily brief filters on the flag. Filtering at
// ingest would throw away the record of a quake the region felt.
import { resolveDocumentId } from "./document-linkage.ts";
import type { NewItemInput, ScraperDef } from "./types.ts";

// The two city centers the rest of the pipeline already uses (see
// nws-forecast.ts), and their midpoint, which is what the search ring is drawn
// around. The cities are 4.5 km apart, so one ring covers both.
const CITIES = [
	{ city: "Chino", lat: 33.99, lon: -117.69 },
	{ city: "Chino Hills", lat: 33.95, lon: -117.73 },
] as const;
const CENTER = { lat: 33.97, lon: -117.71 };

// --- Thresholds, measured rather than guessed --------------------------------
//
// Checked against every M2.0+ event within 50 km in the year to 2026-09-02
// (65 events). What the data says:
//
//   * Magnitude alone is a bad relevance filter. The 50 km ring's east side is
//     the Loma Linda / Redlands swarm, 45 km away, which produced eight M2.5+
//     events including four above M3. Those are San Bernardino stories.
//   * Distance is the signal that matters. Of the four M2.5+ events within
//     25 km, every one drew 128+ "Did You Feel It" reports (128, 151, 402,
//     549). Not one was noise.
//
// So: search wide, flag close. 27 events/yr are ingested, ~4/yr are flagged
// Chino-relevant and can reach the brief.
const SEARCH_RADIUS_KM = 50;
const MIN_MAGNITUDE = 2.5;
const RELEVANT_RADIUS_KM = 25;
// A big quake is felt far past the ring above, and the year sampled contained
// nothing above M3.5 to calibrate against. This clause never fired in that
// sample and exists so a genuinely large event outside 25 km cannot be dropped
// by a threshold tuned on small ones.
const RELEVANT_ANY_DISTANCE_MAG = 4.0;
// Events stay in the query window while USGS revises them (see the status note
// on mapQuake), so a revision lands as an in-place item update rather than
// being missed. 27 events/yr means this window is usually empty.
const WINDOW_DAYS = 7;

interface QuakeFeature {
	id?: string;
	properties?: {
		mag?: number | null;
		place?: string | null;
		time?: number | null;
		updated?: number | null;
		url?: string | null;
		felt?: number | null;
		cdi?: number | null;
		mmi?: number | null;
		alert?: string | null;
		status?: string | null;
		tsunami?: number | null;
		sig?: number | null;
		net?: string | null;
		code?: string | null;
		magType?: string | null;
		type?: string | null;
		title?: string | null;
	};
	geometry?: { coordinates?: number[] };
}

/** Great-circle km between two decimal-degree points. */
export function distanceKm(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371;
	const p1 = (lat1 * Math.PI) / 180;
	const p2 = (lat2 * Math.PI) / 180;
	const dp = p2 - p1;
	const dl = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function kmLabel(km: number): string {
	return km < 1 ? "under 1 km" : `${Math.round(km)} km`;
}

/**
 * One GeoJSON feature -> one item, or null when the feature cannot be described
 * honestly (no magnitude, no time, or no event permalink to cite).
 *
 * Exported for tests.
 */
export function mapQuake(
	f: QuakeFeature,
): Omit<NewItemInput, "document_id"> | null {
	const p = f.properties;
	const coords = f.geometry?.coordinates;
	const eventId = f.id;
	// Every one of these is required to publish a defensible line. A magnitude
	// is the claim, the event page is the citation, the coordinates are how we
	// state distance from Chino, and without a time there is no occurred_at to
	// place it in a day's brief.
	if (!eventId || !p || typeof p.mag !== "number" || typeof p.time !== "number")
		return null;
	if (!p.url || !coords || coords.length < 2) return null;
	const [lon, lat, depthKm] = coords;
	if (typeof lat !== "number" || typeof lon !== "number") return null;

	const distances = CITIES.map((c) => ({
		city: c.city,
		km: distanceKm(lat, lon, c.lat, c.lon),
	}));
	const nearest = distances.reduce((a, b) => (b.km < a.km ? b : a));
	const chinoRelevant =
		nearest.km <= RELEVANT_RADIUS_KM || p.mag >= RELEVANT_ANY_DISTANCE_MAG;

	// USGS revises magnitudes: this event was pushed to phones as M3.36 and
	// settled at M3.2 `reviewed` eleven hours later. Saying "preliminary" while
	// status is anything else is the honest version of a number that is going to
	// move, and re-runs rewrite the item in place as the review lands.
	const preliminary = p.status !== "reviewed";
	// USGS's own `place` is nearest-city and never says Chino ("6 km SE of
	// Ontario, CA"). Distance from Chino is ours and is stated as ours; their
	// wording is kept verbatim in the parenthetical.
	const title =
		`${preliminary ? "Preliminary " : ""}M ${p.mag.toFixed(1)} earthquake, ` +
		`${kmLabel(nearest.km)} from ${nearest.city}` +
		(p.place ? ` (${p.place})` : "");

	return {
		source_url: p.url,
		item_type: "alert",
		external_id: eventId,
		title,
		body: null,
		occurred_at: new Date(p.time).toISOString(),
		meta: {
			chinoRelevant,
			magnitude: p.mag,
			magType: p.magType ?? null,
			status: p.status ?? null,
			preliminary,
			place: p.place ?? null,
			latitude: lat,
			longitude: lon,
			depthKm: typeof depthKm === "number" ? depthKm : null,
			nearestCity: nearest.city,
			nearestCityKm: Math.round(nearest.km * 10) / 10,
			distancesKm: Object.fromEntries(
				distances.map((d) => [d.city, Math.round(d.km * 10) / 10]),
			),
			// "Did You Feel It" responses — the honest measure of whether people
			// here noticed, and worth more than magnitude when deciding that.
			felt: p.felt ?? null,
			cdi: p.cdi ?? null,
			mmi: p.mmi ?? null,
			alert: p.alert ?? null,
			tsunami: p.tsunami ?? null,
			significance: p.sig ?? null,
			network: p.net ?? null,
			usgsTitle: p.title ?? null,
			usgsUpdated:
				typeof p.updated === "number"
					? new Date(p.updated).toISOString()
					: null,
		},
	};
}

/** UTC date (YYYY-MM-DD) `days` before `now`. Exported for tests. */
export function windowStart(now: Date, days: number): string {
	return new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
}

// The response embeds `metadata.generated`, a fresh epoch-ms stamp on every
// request. Documents are content-addressed, so without this an hourly timer
// mints 24 identical archive files a day, forever. Only the stamp is removed —
// the query echo, the count and every feature survive, so what is archived is
// still the full answer USGS gave.
//
// The replacement announces itself rather than being a plausible epoch, for the
// same reason stripCsrfToken's does (chinohills-sports.ts): the archive is this
// project's record of what a source said, and a redaction nobody can spot in it
// is worse than a visible one. Nothing parses the field, so a string is fine.
//
// Non-global on purpose. `metadata.generated` is the first key in the response
// and no feature carries a `generated` field, so replacing only the first match
// means a feature-level field added later cannot be rewritten by accident.
export function stripGenerated(body: Buffer): Buffer {
	return Buffer.from(
		body
			.toString("utf8")
			.replace(
				/"generated":\s*\d+/,
				'"generated":"STRIPPED-BY-CHINO-VALLEY-TODAY"',
			),
		"utf8",
	);
}

const scraper: ScraperDef = {
	key: "usgs-quakes",
	name: "USGS Earthquakes (Chino Valley, 50 km)",
	baseUrl: "https://earthquake.usgs.gov",
	method: "api",
	async run(ctx) {
		// Date-granularity starttime on purpose: an ISO-timestamp start would put
		// a different URL in front of the archive on every run, so nothing would
		// ever hash-match and the "same answer as an hour ago" case could not be
		// recognised.
		const start = windowStart(new Date(), WINDOW_DAYS);
		const url =
			"https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson" +
			`&latitude=${CENTER.lat}&longitude=${CENTER.lon}` +
			`&maxradiuskm=${SEARCH_RADIUS_KM}&minmagnitude=${MIN_MAGNITUDE}` +
			`&starttime=${start}&orderby=time`;

		// docType 'feed', not 'alert': site/src/pages/source/[hash].astro builds
		// an archive page for every 'alert' document, and these need none —
		// citations point straight at the USGS event page, which is a real
		// reader-facing permalink. Same choice cvfd-news and civicplus-rss make
		// for their own alert items.
		const doc = await ctx.fetchDocument(url, {
			docType: "feed",
			title: `USGS earthquakes within ${SEARCH_RADIUS_KM} km of Chino Valley since ${start}`,
			stripVolatile: stripGenerated,
		});

		const parsed = JSON.parse(doc.body.toString("utf8")) as {
			features?: QuakeFeature[];
		};
		const features = parsed.features ?? [];
		let stored = 0;
		let relevant = 0;
		let skipped = 0;
		for (const f of features) {
			const item = mapQuake(f);
			if (!item) {
				skipped++;
				continue;
			}
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
			if ((item.meta as { chinoRelevant: boolean }).chinoRelevant) relevant++;
		}

		ctx.note(
			`${stored} event(s) M${MIN_MAGNITUDE}+ within ${SEARCH_RADIUS_KM} km since ${start}; ` +
				`${relevant} flagged chinoRelevant (within ${RELEVANT_RADIUS_KM} km of a city center, or M${RELEVANT_ANY_DISTANCE_MAG}+)` +
				(skipped ? `; ${skipped} feature(s) skipped as undescribable` : ""),
		);
		if (stored === 0) {
			ctx.note(
				"An empty window is the normal and desirable state: the ring averages 27 events a year.",
			);
		}
		ctx.note(
			"Magnitudes are revised after review; items refresh in place on (document url, item_type, external_id) and titles say 'Preliminary' until USGS marks the event reviewed.",
		);
	},
};

export default scraper;
