import { defineConfig } from "astro/config";

// The origin feeds canonical tags and every RSS item link, so it must match
// wherever the build is actually served. PLAN.md ships first to
// cvtoday.rexlorenzo.com on the existing Caddy droplet and moves to the branded
// domain once validated — pointing canonicals at chinovalley.today while serving
// from the interim host would tell crawlers the real page lives somewhere that
// does not answer yet.
//
// So the branded domain is the default (it is the committed home), and the
// interim deploy overrides it:
//
//   CVT_SITE_ORIGIN=https://cvtoday.rexlorenzo.com npm run build
const SITE_ORIGIN = process.env.CVT_SITE_ORIGIN ?? "https://chinovalley.today";

export default defineConfig({
	site: SITE_ORIGIN,
	trailingSlash: "always",
	build: {
		// Static output rsynced to the droplet at publish (PLAN.md Phase 2).
		format: "directory",
	},
	// Zero client JS by default is a product decision, not a performance nicety:
	// this is a civic record read on phones over patchy connections.
	devToolbar: { enabled: false },
});
