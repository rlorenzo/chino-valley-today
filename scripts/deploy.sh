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
if [ -z "$HOST" ]; then
	echo "deploy: CVT_DEPLOY_HOST is not set." >&2
	echo "  cp deploy/deploy.env.example deploy/deploy.env  and fill it in," >&2
	echo "  or pass it inline: CVT_DEPLOY_HOST=user@host $0 $*" >&2
	exit 78
fi
WEB="${CVT_DEPLOY_WEB:-/var/www/chinovalley.today}"
APP="${CVT_DEPLOY_APP:-/srv/chino-valley-today}"
what="${1:-site}"

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
	# pull: the droplet checkout is a deployment artifact, never a place where
	# work happens, and a merge conflict at 3am in a timer is not a thing worth
	# supporting.
	ssh "$HOST" "
		set -e
		cd '$APP'
		git fetch --quiet origin main
		git reset --hard --quiet origin/main
		npm ci --omit=dev --silent
		git log --oneline -1
	"

	echo "==> syncing systemd units"
	rsync -az -e ssh deploy/systemd/ "$HOST:/etc/systemd/system/"
	ssh "$HOST" "systemctl daemon-reload"
	echo "==> units reloaded (enable them per deploy/README.md)"
}

case "$what" in
	site) deploy_site ;;
	code) deploy_code ;;
	all) deploy_code; deploy_site ;;
	*) echo "usage: $0 <site|code|all>" >&2; exit 64 ;;
esac
