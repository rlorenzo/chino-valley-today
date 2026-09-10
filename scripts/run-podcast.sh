#!/usr/bin/env bash
# Run the weekly podcast pipeline, then rebuild and publish the site if a
# published episode is newer than the live release.
#
# Used by cvt-podcast.timer (deploy/systemd/), which fires three times a week
# because the free Gemini TTS tier's capacity is sheddable — most firings find
# the week's episode already published (src/podcast/run.ts is idempotent) and
# exit here having rebuilt nothing.
#
# "Newer than the live release" rather than "changed during this run": a
# rebuild that fails after the episode published leaves the file newer than
# the release, so the next firing tries the rebuild again instead of seeing
# an unchanged listing and skipping it forever.
#
#   scripts/run-podcast.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WEB="${CVT_DEPLOY_WEB:-/var/www/chinovalley.today}"

node src/podcast/run.ts

# The trailing slash follows the `current` symlink to the release directory,
# whose mtime is the moment it was assembled.
if [ ! -d "$WEB/current/" ] || [ -n "$(find content/published -maxdepth 1 -name '*-podcast.md' -newer "$WEB/current/" 2>/dev/null)" ]; then
	scripts/deploy.sh local
else
	echo "run-podcast: live release already carries every published episode, skipping site rebuild"
fi
