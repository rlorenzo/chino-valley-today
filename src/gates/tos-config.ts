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
};
