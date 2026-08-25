/**
 * CAP (Common Alerting Protocol) as api.weather.gov serves it, shaped for
 * reading.
 *
 * This exists because an NWS citation used to land a reader on
 * `api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.<hash>.002.1` — permanent,
 * machine-checkable, and unreadable by a person. There is no per-alert human
 * page at NWS to point at instead (checked 2026-08-25: CAP's own `web` field is
 * just http://www.weather.gov, and alerts.weather.gov no longer resolves).
 *
 * Deliberately free of Astro and of the filesystem: the archive reader hands it
 * bytes, the page hands it to a template, and src/site/cap-render.test.ts can
 * import it directly.
 */

/** One alert, as it stood in the archived fetch. Every field may be absent. */
export interface CapAlert {
	/** The alert's own CAP id — also the page anchor and items.external_id. */
	id: string;
	/** The permanent API URL for this alert. The authority; the page is a mirror. */
	originalUrl: string | null;
	event: string | null;
	headline: string | null;
	/**
	 * `parameters.NWSheadline` — the one line that states an upgrade, extension
	 * or expiry in plain words ("HEAT ADVISORY WILL EXPIRE AT 8 PM PDT THIS
	 * EVENING"). Often the most useful sentence in the whole record.
	 */
	nwsHeadline: string | null;
	description: string | null;
	instruction: string | null;
	senderName: string | null;
	sent: string | null;
	effective: string | null;
	onset: string | null;
	ends: string | null;
	expires: string | null;
	severity: string | null;
	certainty: string | null;
	urgency: string | null;
	status: string | null;
	messageType: string | null;
	areaDesc: string | null;
}

/** A `\n\n`-separated block of CAP text, unwrapped and classified. */
export type CapBlock =
	| { kind: "para"; text: string }
	| { kind: "list"; items: string[] };

interface RawFeature {
	id?: unknown;
	properties?: Record<string, unknown>;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v : null;
}

/** First entry of a `parameters` array, which CAP always makes a list. */
function param(
	properties: Record<string, unknown>,
	name: string,
): string | null {
	const params = properties.parameters;
	if (!params || typeof params !== "object") return null;
	const values = (params as Record<string, unknown>)[name];
	return Array.isArray(values) ? str(values[0]) : null;
}

/**
 * Parses an api.weather.gov alerts feed into its alerts, or returns null if the
 * bytes are not one.
 *
 * Null rather than an empty array, because the two mean different things to the
 * page: "this document is not a CAP feed, render it as bytes" versus "this is a
 * CAP feed and nothing was in effect", which is a real and reportable state.
 */
export function parseCapFeed(text: string): CapAlert[] | null {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	if (!json || typeof json !== "object") return null;
	const features = (json as { features?: unknown }).features;
	if (!Array.isArray(features)) return null;

	const alerts: CapAlert[] = [];
	for (const feature of features as RawFeature[]) {
		const p = feature?.properties;
		if (!p || typeof p !== "object") continue;
		// A CAP record without an id cannot be anchored or cited, so it is not one
		// this page can serve. Skipping is right: the whole document's bytes are
		// still linked at the top for anyone who needs them.
		const id = str(p.id) ?? str(feature.id);
		if (!id) continue;
		alerts.push({
			id,
			originalUrl: str(p["@id"]) ?? str(feature.id),
			event: str(p.event),
			headline: str(p.headline),
			nwsHeadline: param(p, "NWSheadline"),
			description: str(p.description),
			instruction: str(p.instruction),
			senderName: str(p.senderName),
			sent: str(p.sent),
			effective: str(p.effective),
			onset: str(p.onset),
			ends: str(p.ends),
			expires: str(p.expires),
			severity: str(p.severity),
			certainty: str(p.certainty),
			urgency: str(p.urgency),
			status: str(p.status),
			messageType: str(p.messageType),
			areaDesc: str(p.areaDesc),
		});
	}
	return alerts;
}

/**
 * CAP prose into blocks a browser can lay out.
 *
 * NWS hard-wraps its text at about 70 columns and separates real paragraphs
 * with a blank line, so a single newline is a teletype artifact and joining it
 * back up is restoring the sentence, not editing it. The `* WHAT...` /
 * `* WHERE...` convention is a list; consecutive starred paragraphs become one.
 */
export function capBlocks(text: string | null): CapBlock[] {
	if (!text) return [];
	const unwrapped = text
		.split(/\n\s*\n/)
		.map((p) => p.replace(/\s*\n\s*/g, " ").trim())
		.filter(Boolean);

	const blocks: CapBlock[] = [];
	for (const para of unwrapped) {
		const bullet = para.match(/^\*\s+(.*)$/s);
		if (bullet) {
			const last = blocks.at(-1);
			if (last?.kind === "list") last.items.push(bullet[1]);
			else blocks.push({ kind: "list", items: [bullet[1]] });
		} else {
			blocks.push({ kind: "para", text: para });
		}
	}
	return blocks;
}

/**
 * "Sun, Aug 9, 2026 at 7:49 PM PDT" for a CAP timestamp, in Chino's own zone.
 *
 * CAP stamps carry an offset (`2026-08-09T19:49:00-07:00`), so this is a
 * re-display of a known instant rather than a guess about one. An unparseable
 * value comes back as-is: showing the raw string is honest, inventing a date
 * is not.
 */
export function formatCapInstant(iso: string | null): string | null {
	if (!iso) return null;
	const t = new Date(iso);
	if (Number.isNaN(t.getTime())) return iso;
	return t.toLocaleString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
		timeZone: "America/Los_Angeles",
	});
}

/**
 * The alert's own title line: the event name, qualified by what this issuance
 * did to it. A feed carries a Heat Advisory's initial issuance, its updates and
 * its cancellation under the same event name, and a page that titled all three
 * "Heat Advisory" would be the cancelled-alert-rendered-as-active failure one
 * layer down.
 */
export function capAlertTitle(alert: CapAlert): string {
	const event = alert.event ?? "Alert";
	const type = alert.messageType;
	if (!type || type === "Alert") return event;
	return `${event} — ${type}`;
}
