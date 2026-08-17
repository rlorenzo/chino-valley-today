import { getCollection } from "astro:content";
import { publishedOnly } from "../lib/record.ts";

// Plain-text health endpoint at /health, for an external uptime monitor.
//
// WHAT THIS CAN AND CANNOT TELL YOU, because the difference matters here:
//
// This is a STATIC site. The file below is written at build time and then
// served by the web server from disk. A keyword monitor hitting it proves the
// droplet is up, the web server is running, TLS is valid and the release
// symlink resolves. That is worth monitoring and it is what `ok` means.
//
// It does NOT prove the pipeline is alive. If every scrape timer died tonight,
// this endpoint would keep returning `ok` indefinitely while the site quietly
// served a frozen record. For a publication whose whole claim is currency,
// silently going stale is a worse failure than visibly going down, because
// nobody is alerted by content that simply stops changing.
//
// So the freshness fields are emitted for a human or a smarter check to read,
// and the actual staleness alarm belongs elsewhere: a dead-man's-switch that
// the scrape timers ping on success (see scripts/run-group.sh, CVT_HEARTBEAT_URL)
// and systemd OnFailure= notifications. deploy/README.md covers both.
export async function GET() {
	const posts = publishedOnly(await getCollection("posts"));

	// Newest publication date in the record. Real data or nothing — an empty
	// record reports "none" rather than inventing a date.
	const latest = posts
		.map((p) => p.data.date)
		.sort((a, b) => b.getTime() - a.getTime())[0];

	const body = [
		// First line is the keyword an uptime monitor matches on, alone on the
		// line so a substring match cannot pass accidentally on other content.
		"ok",
		`built=${new Date().toISOString()}`,
		`posts=${posts.length}`,
		`latest_post=${latest ? latest.toISOString().slice(0, 10) : "none"}`,
	].join("\n");

	return new Response(`${body}\n`, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			// Never cache a health check: a cached `ok` outlives the thing it
			// was reporting on.
			"cache-control": "no-store",
		},
	});
}
