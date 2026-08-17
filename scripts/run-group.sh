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
	# Cheap, high-churn: news feeds, weather alerts, and the Nixle mailbox.
	# Hourly is well inside every one of these sources' politeness budget.
	frequent)
		keys=(chino-news-rss chinohills-news-rss nws-alerts sbsheriff-news sbsheriff-nixle-mail)
		;;
	# Agenda systems and listings. These change when a clerk posts a packet,
	# which is a daily-at-most event, and the agenda systems are the sources
	# we least want to hammer.
	daily)
		keys=(chino-legistar chino-agendacenter chinohills-agendas cvusd-board abc-licenses)
		;;
	# Video and captions. Expensive in time and bandwidth, and captions do not
	# exist until well after a meeting ends, so this runs the morning after.
	media)
		keys=(chinohills-swagit youtube-captions chino-youtube-captions)
		;;
	*)
		echo "usage: $0 <frequent|daily|media>" >&2
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
exit "$failed"
