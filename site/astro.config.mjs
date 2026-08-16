import { defineConfig } from "astro/config";

// The site origin is a single value on purpose: PLAN.md ships first to
// cvtoday.rexlorenzo.com on the existing Caddy droplet and moves to the branded
// domain once validated, so the move must be one line, not a find-and-replace
// through canonical tags and the RSS feed.
export default defineConfig({
	site: "https://chinovalley.today",
	trailingSlash: "always",
	build: {
		// Static output rsynced to the droplet at publish (PLAN.md Phase 2).
		format: "directory",
	},
	// Zero client JS by default is a product decision, not a performance nicety:
	// this is a civic record read on phones over patchy connections.
	devToolbar: { enabled: false },
});
