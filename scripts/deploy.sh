#!/usr/bin/env bash
# Deploy to the droplet. Run from a developer machine, not on the droplet.
#
#   scripts/deploy.sh site     build and publish the static site (default)
#   scripts/deploy.sh code     update the pipeline checkout + deps + units
#   scripts/deploy.sh all      both
#
# THE TARGET HOST IS SHARED with other, unrelated services. Nothing here
# touches the web server's config or restarts it — adding the site block is a
# one-time manual step documented in deploy/README.md, kept manual precisely
# because a bad reload takes those co-tenant sites down too.
#
# Config comes from deploy/deploy.env (gitignored) or the environment. The
# target host is deliberately NOT defaulted in tracked source: this repo is
# public, and an origin address in it would defeat any future CDN/proxy in
# front of the site. See deploy/deploy.env.example.
#
#   CVT_DEPLOY_HOST   ssh target (required), e.g. an ~/.ssh/config alias
#   CVT_DEPLOY_WEB    served directory, default /var/www/chinovalley.today
#   CVT_DEPLOY_APP    pipeline checkout, default /srv/chino-valley-today
#
# The remote command strings below interpolate $WEB/$APP/$release on the CLIENT
# side, which is the intent: those are this script's own configuration, not
# remote state, so the droplet must receive literal paths. shellcheck flags
# every such expansion (SC2029) because it is a common accident; here it is the
# design, and the values are ours rather than user input.
# shellcheck disable=SC2029
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/deploy/deploy.env" ]; then
	set -a
	# shellcheck disable=SC1091  # gitignored, per-operator, not checkable here
	. "$ROOT/deploy/deploy.env"
	set +a
fi

HOST="${CVT_DEPLOY_HOST:-}"
WEB="${CVT_DEPLOY_WEB:-/var/www/chinovalley.today}"
APP="${CVT_DEPLOY_APP:-/srv/chino-valley-today}"
what="${1:-site}"

# `local` runs ON the target and needs no ssh target; every other mode reaches
# out over ssh and cannot proceed without one.
if [ "$what" != "local" ] && [ -z "$HOST" ]; then
	echo "deploy: CVT_DEPLOY_HOST is not set." >&2
	echo "  cp deploy/deploy.env.example deploy/deploy.env  and fill it in," >&2
	echo "  or pass it inline: CVT_DEPLOY_HOST=user@host $0 $*" >&2
	exit 78
fi

deploy_site() {
	echo "==> building the site"
	# No CVT_SITE_ORIGIN override: astro.config.mjs already defaults to
	# https://chinovalley.today, which is what this host serves.
	(cd site && npm ci --silent && npm run build)

	[ -f site/dist/index.html ] || { echo "deploy: build produced no index.html" >&2; exit 1; }

	# Releases are published atomically by swapping a symlink, rather than
	# rsync --delete'ing over the live directory. An interrupted rsync into the
	# live root serves a half-updated site; a symlink swap is a rename, so a
	# reader gets either the old release or the new one and never a mix. It
	# also makes rollback a second swap instead of a rebuild.
	local release
	release="$(date -u +%Y%m%dT%H%M%SZ)"

	echo "==> uploading release $release"
	ssh "$HOST" "mkdir -p '$WEB/releases/$release'"
	rsync -az --delete \
		-e ssh \
		site/dist/ "$HOST:$WEB/releases/$release/"

	echo "==> activating"
	# ln -T -f -s writes the new link to a temp name and renames it over the
	# old one, which is atomic. Without -T, ln would helpfully create the link
	# *inside* the existing current/ directory instead of replacing it.
	ssh "$HOST" "
		set -e
		ln -sfnT '$WEB/releases/$release' '$WEB/current.new'
		mv -T '$WEB/current.new' '$WEB/current'
		# Keep the last 5 releases for rollback, drop older ones.
		cd '$WEB/releases' && ls -1t | tail -n +6 | xargs -r rm -rf
	"
	echo "==> site live at $WEB/current -> releases/$release"
}

deploy_code() {
	echo "==> updating the pipeline checkout"
	# The repo is public, so this needs no deploy key. Hard reset rather than
	# pull: the checkout is a deployment artifact for CODE, never a place where
	# code work happens, and a merge conflict at 3am in a timer is not a thing
	# worth supporting.
	#
	# BUT the checkout is NOT purely disposable, and this is the sharp edge:
	# content/published/ is tracked, and the pipeline WRITES there when a human
	# approves a post in the dashboard. A bare `git reset --hard` would delete
	# any post published on the host but not yet in origin/main — a
	# human-approved post, destroyed by a routine deploy.
	#
	# So published posts are preserved across the reset and restored after it.
	# They are the one thing on this host that exists nowhere else.
	ssh "$HOST" "
		set -e
		cd '$APP'
		git fetch --quiet origin main

		# Refuse to reset over divergent published content.
		#
		# An earlier version of this preserved-and-restored it, which was worse
		# than useless: for a MODIFIED post (what a visible correction looks
		# like) the reset restores origin's copy and the restore cannot tell
		# which version should win, so it silently picked one. Losing a
		# correction to a routine deploy is exactly the silent edit EDITORIAL.md
		# forbids.
		#
		# Note new, untracked posts were never at risk — \`git reset --hard\`
		# leaves untracked files alone. The real exposure is edits to posts
		# already in git.
		#
		# So: back the divergence up where it cannot be lost, and stop. A human
		# decides whether it belongs in the repo. Deploys resume once the tree
		# is clean.
		if [ -n \"\$(git status --porcelain content/published)\" ]; then
			stamp=\$(date -u +%Y%m%dT%H%M%SZ)
			safe=\"\$HOME/diverged-content/\$stamp\"
			mkdir -p \"\$safe\"
			cp -a content/published/. \"\$safe/\"
			echo 'deploy: content/published on the host differs from origin/main.' >&2
			echo \"  A copy is safe at \$safe\" >&2
			echo '  Files:' >&2
			git status --porcelain content/published | sed 's/^/    /' >&2
			echo '  Commit them to the repo (or discard them), then deploy again.' >&2
			exit 75
		fi

		git reset --hard --quiet origin/main
		npm ci --omit=dev --silent
		git log --oneline -1
	"

	echo "==> syncing systemd units"
	rsync -az -e ssh deploy/systemd/ "$HOST:/etc/systemd/system/"
	ssh "$HOST" "systemctl daemon-reload"
	echo "==> units reloaded (enable them per deploy/README.md)"
}

# Run ON the host, not from a developer machine. This is what CI invokes over
# SSH, and what the operator runs after approving a post in the dashboard.
#
# It builds from the HOST's own checkout and content, which is the point:
# content/published/ is written on this host when a human approves a post, so a
# site built anywhere else would silently omit it. Building here means whatever
# was just published is in the next release.
deploy_local() {
	echo "==> building on host from the local checkout"
	[ -d "$ROOT/site" ] || { echo "deploy: no site/ directory here" >&2; exit 66; }

	(cd "$ROOT/site" && npm ci --silent && npm run build)
	[ -f "$ROOT/site/dist/index.html" ] || { echo "deploy: build produced no index.html" >&2; exit 1; }

	local release
	release="$(date -u +%Y%m%dT%H%M%SZ)"
	mkdir -p "$WEB/releases/$release"
	# Local copy rather than rsync-over-ssh; same atomic-swap discipline.
	cp -a "$ROOT/site/dist/." "$WEB/releases/$release/"

	ln -sfnT "$WEB/releases/$release" "$WEB/current.new"
	mv -T "$WEB/current.new" "$WEB/current"
	# Release names are ISO-8601 UTC stamps, so a reverse lexicographic sort is
	# newest-first — and is stricter than sorting by mtime, which a restore or a
	# touch could scramble.
	find "$WEB/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' |
		sort -r | tail -n +6 | while read -r old; do
		rm -rf "${WEB:?}/releases/${old:?}"
	done

	echo "==> site live at $WEB/current -> releases/$release"
}

case "$what" in
	site) deploy_site ;;
	code) deploy_code ;;
	all) deploy_code; deploy_site ;;
	local) deploy_local ;;
	*) echo "usage: $0 <site|code|all|local>" >&2; exit 64 ;;
esac
