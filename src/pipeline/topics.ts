// Topic classification. The pipeline owns this because it owns the two signals
// that actually identify a post's subject — the source key it was scraped from
// and the item types it was built out of. The site used to derive topics by
// regex over the rendered title (site/src/lib/record.ts), which could only ever
// guess; it now reads the `topics` frontmatter this module produces.
//
// Taxonomy decided 2026-08-23 (PLAN.md Task 4.5):
//   - `safety` absorbs fire/EMS incidents as well as agency alert channels.
//   - `sports` is a topic of its own, fed by the Task 4.8 weekly roundup.
//   - Calendar events get no topic: they are not posts, and /calendar/ serves
//     them. Nothing here should invent a topic for them.
//   - Secondary press ("headlines elsewhere") gets no topic. A topic page is
//     the record, and another outlet's reporting is attribution, not
//     provenance — the same line the violet stamp rule draws visually.
//   - Daily briefs get no topic: a brief digests every subject, so filing it
//     would put it under every mark and make each one noisier for no gain.
//
// Classification stays deliberately conservative. Mis-filing a civic record is
// worse than leaving it untagged, and an untagged post still appears in the
// main record, which is the complete set.

export const TOPIC_SLUGS = [
	"planning",
	"cvusd",
	"business",
	"safety",
	"sports",
] as const;

export type TopicSlug = (typeof TOPIC_SLUGS)[number];

/**
 * Post types that never carry a topic, and why.
 *
 * `daily-brief` digests everything; `news_digest` is our roundup of both
 * cities' newsflash feeds, which spans subjects the same way a brief does.
 * Both are reachable from the front page without a mark.
 */
const UNTOPICED_POST_TYPES = new Set(["daily-brief", "news_digest"]);

/**
 * Source keys whose items are secondary press. Excluded by ruling, not by
 * accident: these never reach a topic page even if some other signal on the
 * post would otherwise file it.
 */
const PRESS_SOURCE_KEYS = new Set([
	"breeze-news",
	"bulldogtimes-news",
	"champion-news",
	"dailybulletin-news",
	"nbc4-news",
	"quest-news",
]);

/** Post types that identify a topic outright. */
const TOPIC_BY_POST_TYPE: Record<string, TopicSlug> = {
	business_tracker: "business",
	business_narrative: "business",
	alert: "safety",
};

/** Source keys that identify a topic outright. */
const TOPIC_BY_SOURCE_KEY: Record<string, TopicSlug> = {
	"abc-licenses": "business",
	"cvusd-board": "cvusd",
	// Fire and EMS: `safety` absorbs incidents, not just issued notices.
	"cvfd-news": "safety",
	"sbcfire-news": "safety",
	"nws-alerts": "safety",
	"sbsheriff-news": "safety",
	"sbsheriff-nixle-mail": "safety",
	"chinohigh-sports": "sports",
	"ayala-sports": "sports",
	"donlugo-sports": "sports",
};

/** Item types that identify a topic regardless of where they came from. */
const TOPIC_BY_ITEM_TYPE: Record<string, TopicSlug> = {
	alert: "safety",
	fire_incident: "safety",
	ems_incident: "safety",
	license_event: "business",
	// One type for played and unplayed games alike: identity is
	// (document, item_type, external_id), so splitting them would open a second
	// row the moment a scheduled game gained its score.
	game: "sports",
};

/**
 * Hostnames that identify a topic, for classifying a post from its published
 * frontmatter alone — the backfill has source URLs but no source keys. Same
 * rules, weaker evidence, so it is consulted last.
 */
const TOPIC_BY_HOST: Record<string, TopicSlug> = {
	"abc.ca.gov": "business",
	"api.weather.gov": "safety",
	"local.nixle.com": "safety",
	"files.smartsites.parentsquare.com": "cvusd",
};

export interface TopicSignals {
	postType: string;
	title?: string;
	/** Source keys the post was built from — the strongest signal. */
	sourceKeys?: readonly string[];
	/** Item types the post was built from. */
	itemTypes?: readonly string[];
	/** Source URLs, used only when no source key is available. */
	sources?: readonly string[];
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * A meeting body names its own subject, and nothing else on the post does: a
 * Planning Commission preview and a City Council preview come from the same
 * source key, the same item type and the same host. The title is the only
 * place they differ, so it is consulted for exactly this one distinction
 * rather than as a general-purpose classifier.
 */
function topicFromMeetingBody(title: string): TopicSlug | null {
	const hay = title.toLowerCase();
	if (/planning commission/.test(hay)) return "planning";
	if (/board of education|cvusd/.test(hay)) return "cvusd";
	return null;
}

/**
 * Deterministic; never throws. Returns topics in TOPIC_SLUGS order so the same
 * post always renders its chips the same way.
 */
export function classifyTopics(signals: TopicSignals): TopicSlug[] {
	if (UNTOPICED_POST_TYPES.has(signals.postType)) return [];

	// A post built from secondary press is attribution, not record. Checked
	// before anything else can add a topic: the ruling is an exclusion, so it
	// has to outrank every positive signal rather than race them.
	const keys = signals.sourceKeys ?? [];
	if (keys.length > 0 && keys.every((k) => PRESS_SOURCE_KEYS.has(k))) return [];

	const found = new Set<TopicSlug>();

	const byPostType = TOPIC_BY_POST_TYPE[signals.postType];
	if (byPostType) found.add(byPostType);

	for (const key of keys) {
		const topic = TOPIC_BY_SOURCE_KEY[key];
		if (topic) found.add(topic);
	}

	for (const itemType of signals.itemTypes ?? []) {
		const topic = TOPIC_BY_ITEM_TYPE[itemType];
		if (topic) found.add(topic);
	}

	if (signals.title) {
		const topic = topicFromMeetingBody(signals.title);
		if (topic) found.add(topic);
	}

	// Hosts are the fallback for posts classified from frontmatter alone.
	if (keys.length === 0) {
		for (const url of signals.sources ?? []) {
			const host = hostOf(url);
			const topic = host ? TOPIC_BY_HOST[host] : undefined;
			if (topic) found.add(topic);
		}
	}

	return TOPIC_SLUGS.filter((slug) => found.has(slug));
}
