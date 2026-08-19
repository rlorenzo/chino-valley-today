// Deterministic Policy & Eligibility Filter for Secondary Press Headlines.
// Enforces EDITORIAL.md policy requirements for Tier A auto-publishing:
// - Geographic local relevance to Chino / Chino Hills
// - Minors protection
// - Crime, active law enforcement investigations, blotters, accidents
// - Civil litigation, personnel actions, misconduct
// - Private persons (fails closed on unvetted proper names)

import {
	ADJACENT_CITIES,
	CIVIC_ENTITIES_ALLOWLIST,
	LOCAL_GEO_ALIASES,
	PUBLIC_FIGURE_ALLOWLIST,
} from "./allowlists.ts";

// Minors guard (EDITORIAL.md "Private persons": never named, never identifiably
// described, even when the source document names them — the rule names Sheriff
// releases explicitly, because those DO name them).
//
// Two signals, kept narrow on purpose. An earlier draft matched any
// "<n>-year-old" and so held 40-year-old suspects too, which would have held
// nearly every adult release and quietly undone the auto-publish decision. A
// guard that fires on everything is not a safe guard, it is a broken one:
// people stop reading its output.
const EXPLICIT_MINOR_RE =
	/\b(?:juveniles?|minors?|child(?:ren)?|teen(?:ager)?s?|youths?|infants?|toddlers?|newborns?|bab(?:y|ies)|boys?|girls?|high\s+school|middle\s+school|elementary)\b/i;
const AGE_RE = /\b(\d{1,2})[-\s]years?[-\s]old\b/gi;
// Local place names that collide with the minors vocabulary, removed before the
// guard runs. **Boys Republic** is a real institution in Chino Hills with a
// street named after it — a routine adult collision report on Boys Republic
// Drive is exactly the kind of local release this source exists to publish, and
// holding it as a minors item would be the over-firing failure described above,
// concentrated on our own coverage area. Boys & Girls Club is the same problem.
// Scrubbing the place name is safer than weakening `boys?|girls?`, which
// carries real signal ("the boy was found safe").
const PLACE_NAME_RE =
	/\bboys\s+republic\b|\bboys\s*(?:&|and)\s*girls\s+club\b/gi;

const CRIME_RE =
	/\b(?:arrest(?:ed|s|ing)?|suspect(?:s)?|homicide|murder|shooting|shot|stabbed|stabbing|robbery|burglary|assault|dui|manslaughter|felony|indict(?:ed|ment)?|theft|stolen|vandal(?:ism)?|crash|collision|hit-and-run|fatal(?:ity|ities)?)\b/i;

const LE_ACTORS_RE =
	/\b(?:police|sheriff|deput(?:y|ies)|officer(?:s)?|detective(?:s)?|authorities|patrol|blotter|dispatch|fbi)\b/i;
const LE_ACTIONS_RE =
	/\b(?:investigat(?:e|ing|ion|ed)?|probe|inquiry|seek(?:s|ing)?|search(?:ing)?|lookout|wanted|fugitive|person\s+of\s+interest|identif(?:y|ing)|surveillance|footage|video|respond(?:ed|ing)?|warn(?:ing|s)?|pursuit|chase|standoff|raid(?:s)?)\b/i;
const BLOTTER_RE = /\b(?:police|sheriff)\s+blotter\b/i;

const LITIGATION_RE =
	/\b(?:lawsuit|suing|sued|litigation|settlement|disciplinary|misconduct|personnel\s+action)\b/i;

// One list, two shapes. HONORIFIC_NAME_RE scans raw article text, so it needs
// the display spelling with its optional trailing period; isPublicFigure strips
// the same titles off an already-normalized candidate, where the period is gone
// and everything is lowercase. Deriving both from this array is what stops the
// two from drifting — a title added to only one of them either escapes the
// private-person scan or blocks a vetted figure from matching.
const HONORIFIC_TITLES = [
	"Mr.",
	"Mrs.",
	"Ms.",
	"Dr.",
	"Mayor",
	"Trustee",
	"Councilmember",
	"Supervisor",
	"Chief",
	"Officer",
	"Detective",
	"Sheriff",
	"Deputy",
	"Superintendent",
	"President",
	"Director",
	"Coach",
	"Judge",
	"Pastor",
	"Rev.",
	"Principal",
	"Capt.",
	"Sgt.",
	"Lt.",
];

// \b is ASCII-defined even under /u, so it mis-fires next to accented
// letters; a letter lookbehind is the Unicode-safe equivalent.
const HONORIFIC_NAME_RE = new RegExp(
	`(?<!\\p{L})(?:${HONORIFIC_TITLES.map((t) => t.replace(/\./g, "\\.?")).join("|")})\\s+(\\p{Lu}[\\p{L}'’-]+(?:\\s+\\p{Lu}[\\p{L}'’-]+)*)`,
	"gu",
);

// Matches a leading honorific on a normalized candidate ("dr jane doe").
const NORMALIZED_HONORIFIC_PREFIX_RE = new RegExp(
	`^(?:${HONORIFIC_TITLES.map((t) => t.replace(/\./g, "").toLowerCase()).join("|")})\\s+`,
);

// A civic suffix is exactly that: the *last* word of the span. Testing it
// anywhere in the string let any capitalized run that happened to contain one
// pass as a place — "Park Ranger Jane Doe" reads as civic on "Park" alone, and
// the private-person guard is then skipped for the name that follows it.
const CIVIC_SUFFIX_WORDS = new Set(
	"avenue ave street st road rd drive dr boulevard blvd lane court ct way place parkway pkwy highway hwy route park plaza center centre square station club hall room department dept commission council board district school elementary preschool academy university college chamber foundation republic village valley hills shoppes area corner".split(
		" ",
	),
);

// Allowlisted civic entities are removed from the text before name detection
// runs, rather than being matched against whole candidate spans. A span only
// has to *contain* an entity to look civic, and the allowlist holds tokens as
// broad as "Chino" and "California", so "Chino Resident Jane Doe Announces
// Campaign" would otherwise be waved through as a place name. Scrubbing the
// entity in place leaves "Resident Jane Doe Announces Campaign" behind, which
// is what the guard is supposed to see. Longest entity first so "Chino Hills
// High School" is consumed before the bare "Chino" alternative can match.
const CIVIC_ENTITY_SCRUB_RE = new RegExp(
	`\\b(?:${[...CIVIC_ENTITIES_ALLOWLIST]
		.sort((a, b) => b.length - a.length)
		.map((ent) =>
			ent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
		)
		.join("|")})(?:['’]s)?\\b`,
	"gi",
);

// Dictionary stop words that should not be treated as person names when appearing in titles/teasers
const COMMON_WORDS = new Set([
	"the",
	"a",
	"an",
	"in",
	"on",
	"at",
	"for",
	"to",
	"with",
	"from",
	"by",
	"about",
	"into",
	"over",
	"after",
	"and",
	"but",
	"or",
	"nor",
	"as",
	"if",
	"when",
	"while",
	"new",
	"local",
	"public",
	"city",
	"county",
	"state",
	"annual",
	"first",
	"second",
	"third",
	"plan",
	"plans",
	"planning",
	"commission",
	"council",
	"board",
	"meeting",
	"community",
	"business",
	"development",
	"project",
	"report",
	"park",
	"road",
	"street",
	"avenue",
	"center",
	"plaza",
	"station",
	"school",
	"district",
	"fire",
	"water",
	"transit",
	"chamber",
	"event",
	"events",
	"festival",
	"market",
	"program",
	"champions",
	"champion",
	"bulletin",
	"today",
	"area",
	"site",
	"corner",
	"address",
	"addresses",
	"speaks",
	"considers",
	"approves",
	"proposes",
	"announces",
	"hosts",
	"holds",
	"leads",
	"rides",
	"bids",
	"covid",
	"rules",
	"superintendent",
	"neighborhood",
	"cleanup",
	"volunteers",
]);

/**
 * Normalizes a name or entity for comparison (lowercased, alphanumeric and spaces only).
 */
function normalizeEntity(s: string): string {
	return (
		s
			.toLowerCase()
			// Fold diacritics: the allowlists are written in ASCII, so "Jose
			// Hernandez" there must still match "José Hernández" in an article.
			// Without this a vetted public figure spelled with accents reads as an
			// unvetted private person and their civic coverage is silently held.
			.normalize("NFD")
			.replace(/\p{M}+/gu, "")
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}

// The allowlists are module constants, so normalize them once at load rather
// than re-normalizing every entry on every candidate. Both gates run per item
// and each item can carry dozens of candidate spans.
const CIVIC_ENTITIES_NORMALIZED = new Set(
	CIVIC_ENTITIES_ALLOWLIST.map(normalizeEntity),
);

const PUBLIC_FIGURES_NORMALIZED = PUBLIC_FIGURE_ALLOWLIST.map((figure) => {
	const parts = normalizeEntity(figure).split(" ");
	return {
		full: parts.join(" "),
		first: parts[0],
		last: parts[parts.length - 1],
		hasSurname: parts.length >= 2,
	};
});

/**
 * Checks if a candidate string matches any entry in CIVIC_ENTITIES_ALLOWLIST
 * or has a recognized civic suffix.
 */
export function isCivicEntity(name: string): boolean {
	const norm = normalizeEntity(name);
	if (!norm) return false;
	if (CIVIC_ENTITIES_NORMALIZED.has(norm)) return true;
	const tokens = norm.split(" ");
	return CIVIC_SUFFIX_WORDS.has(tokens[tokens.length - 1]);
}

/**
 * Checks if a candidate string matches any entry in PUBLIC_FIGURE_ALLOWLIST
 * (supporting variants like initial, all-caps, middle initials).
 */
export function isPublicFigure(name: string): boolean {
	const norm = normalizeEntity(name).replace(
		NORMALIZED_HONORIFIC_PREFIX_RE,
		"",
	);
	if (!norm) return false;

	const nameParts = norm.split(" ");
	const nameFirst = nameParts[0];
	const nameLast = nameParts[nameParts.length - 1];

	for (const figure of PUBLIC_FIGURES_NORMALIZED) {
		if (norm === figure.full) return true;

		// Initial variant: "Sonja Shaw" also matches "S. Shaw" and "Sonja M. Shaw".
		// Bounded at 3 tokens (first, optional middle/initial, last). Without the
		// bound, matching only the outer two tokens whitelists anything between
		// them: "Sonja Volunteer Group Meeting Shaw" would read as a vetted figure.
		if (
			figure.hasSurname &&
			nameParts.length >= 2 &&
			nameParts.length <= 3 &&
			nameLast === figure.last &&
			(nameFirst === figure.first || nameFirst === figure.first[0])
		) {
			return true;
		}
	}
	return false;
}

/** True when the text indicates a minor is involved. */
export function mentionsMinor(text: string): boolean {
	// Replaced with a space, not "": removing the place name outright can weld
	// its neighbours into a word the guard then misreads.
	const scrubbed = text.replace(PLACE_NAME_RE, " ");
	if (EXPLICIT_MINOR_RE.test(scrubbed)) return true;
	for (const m of scrubbed.matchAll(AGE_RE)) {
		const age = Number.parseInt(m[1], 10);
		if (age < 18) return true;
	}
	return false;
}

// item.meta arrives as a parsed object from the scrapers and as the raw JSON
// column from the pipeline, so both shapes are accepted here.
function getMeta(meta: unknown): Record<string, unknown> {
	let parsed = meta;
	if (typeof meta === "string") {
		try {
			parsed = JSON.parse(meta);
		} catch {
			return {};
		}
	}
	return parsed && typeof parsed === "object"
		? (parsed as Record<string, unknown>)
		: {};
}

// Compiled once at load. These lists are module constants and isLocallyRelevant
// runs per item, so rebuilding ~20 RegExp objects per call bought nothing.
const LOCAL_GEO_ALIAS_MATCHERS = LOCAL_GEO_ALIASES.map((alias) => ({
	alias,
	re: new RegExp(`\\b${alias}\\b`, "i"),
}));
const ADJACENT_CITY_MATCHERS = ADJACENT_CITIES.map(
	(city) => new RegExp(`\\b${city}\\b`, "i"),
);

export interface PolicyItem {
	title?: string | null;
	body?: string | null;
	meta?: unknown;
}

/**
 * Checks geographic relevance to Chino / Chino Hills.
 */
export function isLocallyRelevant(item: PolicyItem): {
	relevant: boolean;
	evidence?: string;
} {
	const meta = getMeta(item.meta);
	if (meta.city === "Chino" || meta.city === "Chino Hills") {
		return { relevant: true, evidence: `city:${meta.city}` };
	}

	const title = item.title ?? "";
	const body = item.body ?? "";
	const fullText = `${title} ${body}`;

	const matched = LOCAL_GEO_ALIAS_MATCHERS.find(({ re }) => re.test(fullText));
	if (!matched) {
		return { relevant: false };
	}

	// A story headlined on an adjacent city is that city's story, even when the
	// body happens to name Chino — unless the headline anchors here too.
	const titleHasLocalAnchor = LOCAL_GEO_ALIAS_MATCHERS.some(({ re }) =>
		re.test(title),
	);
	if (
		!titleHasLocalAnchor &&
		ADJACENT_CITY_MATCHERS.some((re) => re.test(title))
	) {
		return { relevant: false };
	}

	return { relevant: true, evidence: `geo_alias:${matched.alias}` };
}

/**
 * Extracts candidate person names from text and checks them against allowlists.
 * Fails closed (returns true) if an unvetted person name is detected.
 */
export function hasUnvettedPrivatePerson(text: string): boolean {
	if (!text) return false;

	// Replaced with a space, not "", for the same reason the minors guard does
	// it: dropping the entity outright can weld its neighbours into a name.
	const scrubbed = text.replace(CIVIC_ENTITY_SCRUB_RE, " ");

	// 1. Check honorific patterns: e.g. "Dr. Jane Doe", "Mayor John Smith", "Coach Miller"
	for (const match of scrubbed.matchAll(HONORIFIC_NAME_RE)) {
		const candidate = match[1].trim();
		if (!isCivicEntity(candidate) && !isPublicFigure(candidate)) {
			return true;
		}
	}

	// 2. Tokenize sentences and detect Capitalized Name sequences
	// Supports Unicode letters (\p{Lu}\p{Ll}), hyphens, apostrophes, surname prefixes (de, la, van, von, Mac, Mc)
	const clean = scrubbed.replace(/<[^>]+>/g, " ");

	// Candidate regex: Multi-token proper name forms
	const NAME_PATTERN =
		/(?<!\p{L})(?:(?:\p{Lu}[\p{L}'’-]+|\p{Lu}\.)\s+)+(?:(?:de|la|van|von|der|da|di|Mac|Mc)\s+)*\p{Lu}[\p{L}'’-]+(?!\p{L})/gu;

	for (const match of clean.matchAll(NAME_PATTERN)) {
		const candidate = match[0].trim();
		const tokens = candidate.split(/\s+/);

		// Skip if every word in the candidate is a common dictionary stop word
		const isAllCommon = tokens.every((t) =>
			COMMON_WORDS.has(t.toLowerCase().replace(/[^a-z]/g, "")),
		);
		if (isAllCommon) continue;

		// If it's a known civic entity, landmark, school, or development -> allowed
		if (isCivicEntity(candidate)) continue;

		// If it's a vetted public figure -> allowed
		if (isPublicFigure(candidate)) continue;

		// Unvetted proper name -> fail closed
		return true;
	}

	return false;
}

export interface EligibilityResult {
	eligible: boolean;
	reason?: string;
	evidence?: string;
}

/**
 * Deterministic policy gate evaluating secondary press items for Daily Brief inclusion.
 */
export function filterHeadlineEligibility(item: PolicyItem): EligibilityResult {
	const rel = isLocallyRelevant(item);
	if (!rel.relevant) {
		return { eligible: false, reason: "non_local" };
	}

	const title = item.title ?? "";
	const body = item.body ?? "";
	const fullText = `${title} ${body}`.trim();

	if (mentionsMinor(fullText)) {
		return { eligible: false, reason: "minor" };
	}

	if (CRIME_RE.test(fullText)) {
		return { eligible: false, reason: "crime" };
	}

	if (
		BLOTTER_RE.test(fullText) ||
		(LE_ACTORS_RE.test(fullText) && LE_ACTIONS_RE.test(fullText))
	) {
		return { eligible: false, reason: "law_enforcement" };
	}

	if (LITIGATION_RE.test(fullText)) {
		return { eligible: false, reason: "litigation" };
	}

	if (hasUnvettedPrivatePerson(fullText)) {
		return { eligible: false, reason: "private_person" };
	}

	return { eligible: true, evidence: rel.evidence };
}
