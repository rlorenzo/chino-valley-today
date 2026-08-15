// HTML escaping shared by every page this project renders: the admin dashboard
// (src/admin/render.ts) and the POC report (src/poc-report.ts). It lived
// verbatim in both before, which is the kind of duplication that eventually
// drifts — and this one is load-bearing for safety, so a drift would be a
// vulnerability rather than a cosmetic inconsistency.

// Order matters: `&` MUST be replaced first, or the ampersands introduced by
// the later replacements get double-escaped ("<" -> "&lt;" -> "&amp;lt;").
export function esc(s: unknown): string {
	return String(s ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
