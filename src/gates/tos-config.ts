export interface SourceTosConfig {
	source_key: string;
	status: "enabled" | "held";
	terms_url: string;
	reviewed_hash: string;
	reviewed_at: string;
	reviewer: string;
	notes?: string;
}

export const SOURCE_TOS_REGISTRY: Record<string, SourceTosConfig> = {
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
		status: "enabled",
		terms_url: "https://www.championnewspapers.com/site/terms.html",
		reviewed_hash:
			"b00ff0478d29955b84a444af610933d1d9e29a93c00e68e3a19b254119e587d4",
		reviewed_at: "2026-08-18",
		reviewer: "rexl",
		notes:
			"TownNews Blox CMS Terms of Use reviewed. Permits automated title and short teaser link-back under EDITORIAL.md.",
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
