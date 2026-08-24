#!/usr/bin/env bash
# Run a named group of scrapers, one after another.
#
# Used by the systemd timers on the droplet (deploy/systemd/). Groups exist
# because the sources have wildly different useful polling rates: an RSS feed
# is cheap and changes hourly, a three-hour meeting video is expensive and
# changes once a week.
#
#   scripts/run-group.sh frequent
#   scripts/run-group.sh daily
#   scripts/run-group.sh media
#
# Each scraper runs in its own `node` process, and a failure in one does NOT
# stop the rest — the same independent-try/catch contract `npm run poc` gives.
# A source being down for a day is normal; it must not cost us the other
# twelve. The exit code is the count of failed scrapers, so systemd still
# records a failed unit and `systemctl status` shows which run went wrong.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Not `set -e` here (a failing scraper must not abort the group), so cd needs
# its own guard — running the scrapers from the wrong directory would resolve
# the database path to somewhere unintended.
cd "$ROOT" || exit 70

group="${1:-}"

case "$group" in
	# Cheap, high-churn: news feeds, weather alerts + forecast, fire district
	# feeds, and the Nixle mailbox. Hourly is well inside every one of these
	# sources' politeness budget, and the fire Alert Center is exactly the
	# feed that must not wait a day.
	frequent)
		keys=(chino-news-rss chinohills-news-rss nws-alerts nws-forecast sbcfire-news cvfd-news sbsheriff-news sbsheriff-nixle-mail)
		;;
	# Agenda systems, listings, event calendars, and high school athletics.
	# These change when a clerk or staff member posts something, which is a
	# daily-at-most event, and the agenda systems are the sources we least want
	# to hammer. (yanksair.org's robots.txt asks Crawl-delay: 10 — daily cadence
	# keeps us far inside it.)
	#
	# Sports belong here rather than in `frequent` for two reasons. A score is
	# entered by a coach the evening of the game, so this group's 05:40 slot
	# picks up last night's results ahead of the 05:50 Tier A run and the 06:00
	# brief; and each scraper reads a 14-day-back / 21-day-ahead window in one
	# request, so running it hourly would re-read the same window 24 times for
	# nothing. Two requests per school per day: the schedule API, plus the nav
	# page the per-sport citations are resolved from.
	daily)
		keys=(chino-legistar chino-agendacenter chinohills-agendas cvusd-board abc-licenses sbclib-events sbparks-events cbwcd-events yanksair-events chinohigh-sports ayala-sports donlugo-sports)
		;;
	# Video and captions. Expensive in time and bandwidth, and captions do not
	# exist until well after a meeting ends, so this runs the morning after.
	media)
		keys=(chinohills-swagit youtube-captions chino-youtube-captions)
		;;
	# Secondary press reporting (The Champion, Daily Bulletin, three student
	# papers, NBC4 keyword-filtered). Politeness budget: runs 4 times daily
	# (05:00, 11:00, 17:00, 23:00 PT), fail-closed robots.txt, ToS tracking,
	# and redirect validation. The student papers and NBC4 go quiet or empty
	# on most runs by design (dormant between issues / no Chino match) — see
	# zeroItemsIsHealthy in daily-brief.ts.
	press)
		keys=(champion-news dailybulletin-news quest-news bulldogtimes-news breeze-news nbc4-news)
		;;
	*)
		echo "usage: $0 <frequent|daily|media|press>" >&2
		exit 64
		;;
esac

failed=0
for key in "${keys[@]}"; do
	echo "--- $key"
	if ! node src/run-one.ts "$key"; then
		echo "!!! $key FAILED (continuing)" >&2
		failed=$((failed + 1))
	fi
done

if [ "$failed" -gt 0 ]; then
	echo "$failed of ${#keys[@]} scrapers failed in group '$group'" >&2
fi

# Dead-man's-switch ping, on success only.
#
# This is the check that matters for this project. The public site is static:
# if every timer here died, /health would keep answering `ok` and the site
# would serve a frozen record indefinitely, alerting nobody. A publication
# whose claim is currency fails worse by silently going stale than by visibly
# going down.
#
# So the monitor is inverted — instead of asking "is it up?", the job says
# "I ran", and the monitoring service alerts when that stops arriving. Set
# CVT_HEARTBEAT_URL_<GROUP> to an UptimeRobot heartbeat URL (or healthchecks.io
# equivalent); unset means no ping and no alarm, which is the right default for
# a developer machine.
heartbeat_var="CVT_HEARTBEAT_URL_$(printf '%s' "$group" | tr '[:lower:]' '[:upper:]')"
heartbeat="${!heartbeat_var:-}"
if [ "$failed" -eq 0 ] && [ -n "$heartbeat" ]; then
	# Never let a monitoring outage fail the scrape run itself.
	curl -fsS --max-time 15 "$heartbeat" >/dev/null 2>&1 ||
		echo "note: heartbeat ping to $heartbeat_var failed (scrape itself was fine)" >&2
fi

exit "$failed"
