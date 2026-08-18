import { getCollection } from "astro:content";
import { briefsOnly, expectedBriefDate, publishedOnly } from "../lib/record.ts";

// Plain-text health endpoint at /health, for an external uptime monitor.
//
// WHAT THIS CAN AND CANNOT TELL YOU, because the difference matters here:
//
// This is a STATIC site. The file below is written at build time and then
// served by the web server from disk. A keyword monitor hitting it proves the
// droplet is up, the web server is running, TLS is valid and the release
// symlink resolves. That is worth monitoring and it is what `ok` means.
//
// The `pipeline=` line is the freshness half, for a keyword monitor on a
// free plan (no heartbeat monitors): it reads `fresh` only when the latest
// daily brief is the one this build moment may fairly expect (today's after
// 07:00 Pacific, yesterday's before). The site rebuilds every morning with
// the brief, so a healthy day re-stamps `fresh`; a mid-day rebuild after a
// missed morning stamps `stale` honestly. The one case a build-time stamp
// cannot catch — no rebuild happening at all — is closed by
// cvt-brief-watch.timer, which rewrites the LIVE file to `pipeline=stale`
// when today's brief has not published (src/pipeline/brief-health.ts).
// Configure the monitor to alert when `pipeline=fresh` is ABSENT, so a
// flipped stamp, a mangled page, and a down site all fire the same alarm.
//
// The residual blind spot, recorded honestly: systemd's timers dying
// wholesale (the watchdog included) while the web server keeps serving. That
// failure needs the heartbeat monitors (deploy/README.md); the plain `ok`
// uptime check still covers the host itself going down.
export async function GET() {
	const posts = publishedOnly(await getCollection("posts"));

	// Newest publication date in the record. Real data or nothing — an empty
	// record reports "none" rather than inventing a date.
	const latest = posts
		.map((p) => p.data.date)
		.sort((a, b) => b.getTime() - a.getTime())[0];

	const latestBrief = briefsOnly(posts)[0]?.data.brief_date ?? null;
	const fresh = latestBrief !== null && latestBrief >= expectedBriefDate();

	const body = [
		// First line is the keyword an uptime monitor matches on, alone on the
		// line so a substring match cannot pass accidentally on other content.
		"ok",
		`built=${new Date().toISOString()}`,
		`posts=${posts.length}`,
		`latest_post=${latest ? latest.toISOString().slice(0, 10) : "none"}`,
		`latest_brief=${latestBrief ?? "none"}`,
		`pipeline=${fresh ? "fresh" : "stale"}`,
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
