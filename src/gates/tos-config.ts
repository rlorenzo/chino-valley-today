import type { TermsScope } from "./terms-scope.ts";

export interface SourceTosConfig {
	source_key: string;
	status: "enabled" | "held";
	terms_url: string;
	reviewed_hash: string;
	reviewed_at: string;
	reviewer: string;
	notes?: string;
	/**
	 * Present only where a publisher renders changing content into the same
	 * document as its terms. It does NOT change what is hashed — the gate is
	 * still the raw bytes — it lets a drift be reported as "the terms read the
	 * same once this region is removed" instead of as an unexplained change.
	 *
	 * Note the limit of that claim: what is established is that the two REDUCED
	 * readings match, not that the raw documents differ only inside the region.
	 * See terms-scope.ts.
	 */
	scope?: TermsScope;
}

/**
 * How many times in a row a drift may be cleared by attestation — the short
 * form, where the tool has already established that the terms read the same
 * once the volatile region is removed — before the next one demands a full
 * re-read.
 *
 * A one-command clearance offered every week becomes a reflex by about month
 * four, and a reflex is not a review. The lease is what stops a source drifting
 * indefinitely on a series of individually-reasonable clearances, and it is why
 * ATTEST_LEASE_DAYS exists alongside the count: a quiet source could otherwise
 * go years on seven attestations.
 */
export const MAX_CONSECUTIVE_ATTESTATIONS = 8;
export const ATTEST_LEASE_DAYS = 90;

export const SOURCE_TOS_REGISTRY: Record<string, SourceTosConfig> = {
	"chinohills-sports": {
		source_key: "chinohills-sports",
		status: "enabled",
		terms_url: "https://www.cifsshome.org/robots.txt",
		reviewed_hash:
			"e5c4b84484ee4216e9373be99380320c25dd94805f99f0a805846f087636553f",
		reviewed_at: "2026-08-23",
		reviewer: "claude-code (operator-directed)",
		notes:
			"CIF-SS publishes no reader-facing terms page, so robots.txt is the binding access document — same treatment as the SNO student papers and the Home Campus sites. Fully open: 'User-agent: *' with an empty 'Disallow:' and no Crawl-delay. The /widget/* paths are the public embed surface cifss.org itself iframes. Items cite the widget URL, which is a real page a reader can open and filter.",
	},
	"chinohigh-sports": {
		source_key: "chinohigh-sports",
		status: "enabled",
		terms_url: "https://www.chinohighathletics.com/robots.txt",
		reviewed_hash:
			"fd866565598b822109a8624c8cbe3bb9289b6190c07640f368d7c693a2d16f8f",
		reviewed_at: "2026-08-23",
		reviewer: "claude-code (operator-directed)",
		notes:
			"Home Campus (Chino High) publishes no reader-facing terms page, so robots.txt is the binding access document — same treatment as the SNO student papers. Standard WordPress disallows (/wp-admin/, /wp-includes/, /wp-content/plugins/); /wp-json/ is NOT disallowed. Responses carry x-robots-tag: noindex, an indexing directive rather than an access prohibition: items cite the school's human schedule page, never the API. All three schools serve a byte-identical robots.txt from the same platform template.",
	},
	"ayala-sports": {
		source_key: "ayala-sports",
		status: "enabled",
		terms_url: "https://www.ayalasports.com/robots.txt",
		reviewed_hash:
			"fd866565598b822109a8624c8cbe3bb9289b6190c07640f368d7c693a2d16f8f",
		reviewed_at: "2026-08-23",
		reviewer: "claude-code (operator-directed)",
		notes:
			"Home Campus (Ayala) publishes no reader-facing terms page, so robots.txt is the binding access document — same treatment as the SNO student papers. Standard WordPress disallows (/wp-admin/, /wp-includes/, /wp-content/plugins/); /wp-json/ is NOT disallowed. Responses carry x-robots-tag: noindex, an indexing directive rather than an access prohibition: items cite the school's human schedule page, never the API. All three schools serve a byte-identical robots.txt from the same platform template.",
	},
	"donlugo-sports": {
		source_key: "donlugo-sports",
		status: "enabled",
		terms_url: "https://www.donlugosports.com/robots.txt",
		reviewed_hash:
			"fd866565598b822109a8624c8cbe3bb9289b6190c07640f368d7c693a2d16f8f",
		reviewed_at: "2026-08-23",
		reviewer: "claude-code (operator-directed)",
		notes:
			"Home Campus (Don Lugo) publishes no reader-facing terms page, so robots.txt is the binding access document — same treatment as the SNO student papers. Standard WordPress disallows (/wp-admin/, /wp-includes/, /wp-content/plugins/); /wp-json/ is NOT disallowed. Responses carry x-robots-tag: noindex, an indexing directive rather than an access prohibition: items cite the school's human schedule page, never the API. All three schools serve a byte-identical robots.txt from the same platform template.",
	},
	"champion-news": {
		source_key: "champion-news",
		// NOT INGESTED, by decision (2026-08-26). The lock is in
		// src/scrapers/registry.ts, which no longer lists this scraper, and in
		// scripts/run-group.sh, which no longer schedules it. Nothing invokes it.
		//
		// Why: the Champion's terms prohibit republishing any portion of the
		// content, incorporating it "in any database, compilation, archive or
		// cache", scraping it "without permission", and "any data mining, data
		// gathering or extraction method". This scraper did all four. EDITORIAL.md
		// rejects KTLA on weaker wording, so ingesting the Champion was the
		// project applying its own rule unevenly.
		//
		// This was never a drift: the non-volatile terms digest is identical to
		// the 2026-03-11 archived copy, so the clause was there when the source
		// was approved on 2026-08-18 and the approval simply missed it.
		//
		// The entry stays here on purpose. A written permission request is with
		// the Publisher (the channel their terms require), and if their terms
		// change to permit this, the weekly drift check is how we find out.
		//
		// `held` matters beyond documentation. openDb() seeds source_tos_status
		// from this registry with INSERT OR IGNORE, so a fresh database — a
		// rebuild, a new host — would otherwise come up with this source enabled,
		// and checkHeadlinesFreshness would then let the thirty-six articles
		// already in the corpus publish. It also makes resetSourceTosHold refuse
		// outright ("configured as 'held' in baseline registry"), so clearing this
		// takes editing the contract, which is the point.
		status: "held",
		terms_url: "https://www.championnewspapers.com/site/terms.html",
		reviewed_hash:
			"b00ff0478d29955b84a444af610933d1d9e29a93c00e68e3a19b254119e587d4",
		reviewed_at: "2026-08-18",
		reviewer: "rexl",
		notes:
			"TownNews Blox CMS Terms of Use reviewed. Permits automated title and short teaser link-back under EDITORIAL.md.",
		// This page carries the paper's own most-read and most-commented lists,
		// so its bytes change whenever the Champion publishes. Verified against
		// the 2026-03-11 archived copy: with the tncms widget regions removed,
		// the remaining 26,604 characters are identical to today, five months on.
		//
		// The regions are removed rather than the terms selected, because Blox
		// nests the sidebar INSIDE article#staticpage — selecting the article
		// alone still picks up every headline.
		scope: {
			select: "article#staticpage",
			volatile: "[id^=tncms-region]",
			anchor: "These Terms of Service govern your use of",
			// Measured at 26,604 characters on both the 2026-03-11 archived copy
			// and the live page. The floor sits well under that: it is there to
			// catch a scope that has started stripping the terms, not to notice
			// an edited sentence.
			minLength: 20_000,
		},
	},
	"dailybulletin-news": {
		source_key: "dailybulletin-news",
		status: "enabled",
		terms_url: "https://www.medianewsgroup.com/terms-of-use/",
		reviewed_hash:
			"d48be59531c05ad31906a5d59c5d72533e14c3595f7345afdd2d3d066870fea5",
		reviewed_at: "2026-08-18",
		reviewer: "rexl",
		notes:
			"MediaNews Group Terms of Use for Daily Bulletin reviewed. Permits automated title and short teaser link-back under EDITORIAL.md.",
	},
	"quest-news": {
		source_key: "quest-news",
		status: "enabled",
		terms_url: "https://dalquestnews.org/robots.txt",
		reviewed_hash:
			"ba956d06c6b5aa13616fc2922240aeb3655f34858a88a2f32fc9a98dc86ce3b0",
		reviewed_at: "2026-08-19",
		reviewer: "claude-code (operator-directed)",
		notes:
			"No reader-facing ToS exists (verified 2026-08-19: SNO-platform site, footer carries only a copyright line). robots.txt tracked as the binding access document; permits /feed/, asks Crawl-delay 6.",
	},
	"bulldogtimes-news": {
		source_key: "bulldogtimes-news",
		status: "enabled",
		terms_url: "https://ayalabulldogtimes.org/robots.txt",
		reviewed_hash:
			"ba956d06c6b5aa13616fc2922240aeb3655f34858a88a2f32fc9a98dc86ce3b0",
		reviewed_at: "2026-08-19",
		reviewer: "claude-code (operator-directed)",
		notes:
			"No reader-facing ToS exists (verified 2026-08-19: SNO-platform site, footer carries only a copyright line). robots.txt tracked as the binding access document; permits /feed/, asks Crawl-delay 6.",
	},
	"breeze-news": {
		source_key: "breeze-news",
		status: "enabled",
		terms_url: "https://thebreezepaper.com/robots.txt",
		reviewed_hash:
			"253de8d8c2f969fac67e684a74c09e2f0acda4e18f868d93e99bd70bc3c88345",
		reviewed_at: "2026-08-19",
		reviewer: "claude-code (operator-directed)",
		notes:
			"No general reader-facing ToS (verified 2026-08-19; only a donation-checkout ToS on snosites.com exists, which does not govern reading/linking). robots.txt tracked as the binding access document.",
	},
	"nbc4-news": {
		source_key: "nbc4-news",
		status: "enabled",
		terms_url: "https://www.nbcuniversal.com/terms",
		reviewed_hash:
			"888cc58e55e386cb540d228cfcbec8713565080bcecc2d5dbca9152063261ca3",
		reviewed_at: "2026-08-19",
		reviewer: "claude-code (operator-directed)",
		notes:
			"NBCUniversal general ToS reviewed 2026-08-19: no clause restricts automated access, scraping, RSS use, or headline/link reuse; the feed URL is explicitly robots-Allowed. Title + sentence-bounded teaser link-back per EDITORIAL.md.",
	},
};
