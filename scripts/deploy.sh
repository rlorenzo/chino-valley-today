#!/usr/bin/env bash
# Deploy to the droplet. Run from a developer machine, not on the droplet.
#
#   scripts/deploy.sh site     build and publish the static site (default)
#   scripts/deploy.sh code     update the pipeline checkout + deps + units
#   scripts/deploy.sh all      both
#
# Two more run ON the droplet rather than from a developer machine, and are
# what a forced-command SSH key invokes:
#
#   scripts/deploy.sh local        rebuild the site from the host's checkout
#   scripts/deploy.sh host-update  update the checkout, THEN rebuild
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
# `local` and `host-update` run ON the droplet and never open an SSH
# connection, so they must not require a target. The droplet has no
# deploy/deploy.env (it is gitignored and belongs to developer machines) and no
# CVT_DEPLOY_HOST in the unit environment, so demanding one here would exit 78
# before either could run — which would leave the forced-command CI path unable
# to update or rebuild the checkout at all.
case "$what" in
	local | host-update) ;;
	*)
		if [ -z "$HOST" ]; then
			echo "deploy: CVT_DEPLOY_HOST is not set." >&2
			echo "  cp deploy/deploy.env.example deploy/deploy.env  and fill it in," >&2
			echo "  or pass it inline: CVT_DEPLOY_HOST=user@host $0 $*" >&2
			exit 78
		fi
		;;
esac

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
	# Piped over stdin rather than invoked from the host's checkout, so the
	# version that runs is the one on THIS machine. Calling the host's own copy
	# would run the pre-reset version of the very script doing the reset — and
	# would fail outright on a host provisioned before the script existed.
	ssh "$HOST" "cd '$APP' && bash -s" < "$ROOT/scripts/host-code-update.sh"

	echo "==> syncing systemd units"
	rsync -az -e ssh deploy/systemd/ "$HOST:/etc/systemd/system/"
	ssh "$HOST" "systemctl daemon-reload"
	echo "==> units reloaded"

	# Syncing a unit does NOT enable it, and a timer that exists but is disabled
	# looks identical to one that is working right up until you need it. That
	# has already happened: cvt-tiera shipped and sat disabled, so nothing
	# published for weeks.
	#
	# So enable them, rather than printing a warning and hoping. A warning
	# depends on a human reading deploy output, which is the same class of
	# signal that already failed here twice — and a timer this repo ships is a
	# timer meant to run, or it would not be in deploy/systemd/.
	#
	# Note for future units: `--now` starts the TIMER, not the service, but a
	# unit with Persistent=true whose window was missed will fire straight away.
	# If some later unit's first run has side effects you do not want on a
	# deploy (cvt-tiera publishing a backlog was exactly this), enable it by
	# hand once, deliberately, before it ships here.
	echo "==> enabling timers"
	# A failure to enable must FAIL the deploy. Swallowing it (`enable ... &&
	# record`) left `enabled_now` empty on error, so the run went on to print
	# "all units already enabled" — a false all-clear over the exact silent gap
	# this block exists to close.
	# The check is is-ACTIVE, not is-enabled, and that distinction is load
	# bearing. Tested with a deliberately malformed unit: systemd logged
	# "Timer unit lacks value setting. Refusing." and left it inactive, while
	# `systemctl enable --now` still exited 0 and `is-enabled` reported
	# "enabled". An enabled-but-inactive timer is precisely the silent gap this
	# block exists to close, so enabling is the action and running is the test.
	ssh "$HOST" '
		enabled_now=""
		enable_failed=""
		for unit in /etc/systemd/system/cvt-*.timer; do
			name="$(basename "$unit")"
			systemctl is-enabled --quiet "$name" 2>/dev/null && continue
			if systemctl enable --now "$name" >/dev/null 2>&1; then
				enabled_now="$enabled_now $name"
			else
				enable_failed="$enable_failed $name"
			fi
		done
		if [ -n "$enabled_now" ]; then
			echo "  enabled:$enabled_now"
		fi
		# Report what actually happened. The is-active check below is the
		# authoritative test and would fail the deploy anyway, but a block whose
		# whole purpose is refusing to be vague about timer state has no business
		# printing "enabled: X" for a unit that did not enable.
		if [ -n "$enable_failed" ]; then
			echo "  enable failed:$enable_failed" >&2
		fi

		inactive=""
		for unit in /etc/systemd/system/cvt-*.timer; do
			name="$(basename "$unit")"
			systemctl is-active --quiet "$name" 2>/dev/null ||
				inactive="$inactive $name"
		done
		if [ -n "$inactive" ]; then
			echo "  ERROR: timer(s) installed but NOT running:$inactive" >&2
			for name in $inactive; do
				systemctl status "$name" --no-pager -n 5 2>&1 | sed "s/^/    /" >&2
			done
			exit 1
		fi
		if [ -z "$enabled_now" ]; then
			echo "  all cvt-*.timer units already running"
		fi
		exit 0
	'
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

# Run ON the host: bring the checkout up to origin/main, then rebuild the site
# from it. This is the whole-deploy path for CI.
#
# Everything here runs as the unprivileged service account — a git reset, an
# npm ci and an Astro build, all inside the checkout it already owns. That is
# what makes it safe to hand to a forced-command SSH key: unlike `code`, it
# never writes to /etc/systemd/system and never reloads the daemon.
#
# Why CI needs this at all: the deploy workflow ran `local`, which rebuilds the
# site but never updates the code. Merging to main therefore did NOT ship
# pipeline changes, and nothing surfaced the drift — the droplet ran two merges
# behind for a day without a single signal.
deploy_host_update() {
	bash "$ROOT/scripts/host-code-update.sh"
	deploy_local
}

case "$what" in
	site) deploy_site ;;
	code) deploy_code ;;
	all) deploy_code; deploy_site ;;
	local) deploy_local ;;
	host-update) deploy_host_update ;;
	*) echo "usage: $0 <site|code|all|local|host-update>" >&2; exit 64 ;;
esac
