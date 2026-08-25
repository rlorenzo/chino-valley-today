#!/usr/bin/env bash
# Deploy to the droplet. Run from a developer machine, except the two host-side
# subcommands (local, host-update) below, which run on the droplet itself.
#
#   scripts/deploy.sh code     update the pipeline checkout + deps + units
#   scripts/deploy.sh all      that, then rebuild the site ON the host
#   scripts/deploy.sh site     build HERE and publish — guarded, see below
#
# `all` is the one to reach for. The site should always be built on the droplet,
# because the droplet holds content this checkout does not: queued, held and
# rejected posts are gitignored, published briefs are too, and
# content/published/ is written on the host when a post is approved. `site`
# builds from whatever this machine has and publishes that over the real thing,
# so it refuses unless CVT_ALLOW_LOCAL_BUILD is set.
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

# No default subcommand. It used to be `site`, so a bare `scripts/deploy.sh`
# published a local build; whatever the default is, it should not be the one
# thing here that can overwrite the live site with the wrong content.
what="${1:-}"

# Validated before ANY configuration is read, so a typo says so rather than
# failing on a missing CVT_DEPLOY_HOST it never needed — or on a deploy.env
# that cannot be sourced.
case "$what" in
	site | code | all | local | host-update) ;;
	*)
		echo "usage: $0 <code|all|site|local|host-update>" >&2
		echo "  code  update the checkout, deps and systemd units (needs root on the host)" >&2
		echo "  all   that, then rebuild the site on the host" >&2
		echo "  site  build HERE and publish; guarded, see CVT_ALLOW_LOCAL_BUILD" >&2
		echo "  local / host-update  run ON the droplet" >&2
		exit 64
		;;
esac

# CVT_DEPLOY_ENV overrides which file this reads, and exists so the guard tests
# can point it at /dev/null. A per-operator deploy.env holds the real droplet
# address, and a test that let one leak in would aim its fixtures at production.
ENV_FILE="${CVT_DEPLOY_ENV:-$ROOT/deploy/deploy.env}"
if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090,SC1091  # gitignored, per-operator, not checkable here
	. "$ENV_FILE"
	set +a
fi

HOST="${CVT_DEPLOY_HOST:-}"
WEB="${CVT_DEPLOY_WEB:-/var/www/chinovalley.today}"
APP="${CVT_DEPLOY_APP:-/srv/chino-valley-today}"

# `local` runs ON the target and needs no ssh target; every other mode reaches
# out over ssh and cannot proceed without one.
# `local` and `host-update` run ON the droplet and never open an SSH
# connection, so they must not require a target. The droplet has no
# deploy/deploy.env (it is gitignored and belongs to developer machines) and no
# CVT_DEPLOY_HOST in the unit environment, so demanding one here would exit 78
# before either could run — which would leave the forced-command CI path unable
# to update or rebuild the checkout at all.
# Running these as root is the trap, not a convenience.
#
# `local` and `host-update` build inside $APP/site and publish into $WEB, both
# owned by the unprivileged service account that the timers and the CI forced
# command run as. Run either as root and every file npm and Astro create lands
# root-owned: node_modules, dist, and the release directory. The next
# unprivileged deploy then dies in `npm ci`, which removes node_modules before
# it reinstalls, and the release prune hits the same wall (exit 73 below).
#
# On 2026-08-20 a hand-run `deploy.sh local` over an ssh root@ session did
# exactly that. It published fine, and then two CI deploys failed 90 minutes
# later with a bare exit 243 and no message, because --silent had swallowed the
# EACCES. deploy/README.md already warned that `deploy.sh site` from a
# developer machine lands files owned by the wrong uid; the warning was written
# down but never enforced, one path over.
#
# CVT_ALLOW_ROOT_DEPLOY exists for a genuine root-owned install, where $APP and
# $WEB belong to root and there is no service account to collide with.
case "$what" in
	local | host-update)
		if [ "$(id -u)" -eq 0 ] && [ -z "${CVT_ALLOW_ROOT_DEPLOY:-}" ]; then
			# GNU stat; absent or non-GNU (a developer's macOS) just means we
			# print the advice without a name rather than a broken sudo line.
			owner="$(stat -c '%U' "$APP" 2>/dev/null || true)"
			echo "deploy: refusing to run '$what' as root." >&2
			echo "  Building in $APP as root leaves node_modules, dist and the new" >&2
			echo "  release owned by root, which breaks the next unprivileged deploy" >&2
			echo "  and the release prune." >&2
			if [ -n "$owner" ] && [ "$owner" != root ]; then
				echo "  $APP is owned by '$owner'. Run it as that account:" >&2
				echo "    sudo -u $owner $0 $what" >&2
			else
				echo "  Run it as the account that owns $APP." >&2
			fi
			echo "  (set CVT_ALLOW_ROOT_DEPLOY=1 only on a root-owned install.)" >&2
			exit 77
		fi
		;;
	*)
		if [ -z "$HOST" ]; then
			echo "deploy: CVT_DEPLOY_HOST is not set." >&2
			echo "  cp deploy/deploy.env.example deploy/deploy.env  and fill it in," >&2
			echo "  or pass it inline: CVT_DEPLOY_HOST=user@host $0 $*" >&2
			exit 78
		fi
		;;
esac

# Rebuild the site ON the droplet, from the droplet's own checkout and content.
#
# This is what `all` uses now, in place of deploy_site. The host is a source of
# truth for content that git does not have — content/queue/, content/held/ and
# content/rejected/ are gitignored, published briefs are too, and
# content/published/ is written on the host when a post is approved — so the
# host is the only machine that can build the real site.
#
# Runs as the service account, so the release lands with the right ownership
# and the root guard in deploy_local has nothing to refuse.
rebuild_on_host() {
	echo "==> rebuilding the site on the host"
	# Both paths are forwarded, not just the one that changes behaviour.
	# deploy_local builds from the script's own checkout, so invoking
	# $APP/scripts/deploy.sh already lands in the right tree — but the remote
	# run's own root-refusal message names $APP, and a diagnostic that names a
	# path nobody configured is how an operator ends up fixing the wrong host.
	ssh "$HOST" "sudo -u cvtoday env CVT_DEPLOY_WEB='$WEB' CVT_DEPLOY_APP='$APP' '$APP/scripts/deploy.sh' local"
}

# BUILDS LOCALLY AND PUBLISHES THE RESULT, which is almost always the wrong
# content. Guarded, and left in place only for an emergency where the host
# cannot build at all.
#
# On 2026-08-24 the live site served a laptop's build for about 90 seconds: 18
# posts instead of 35, /brief/2026-08-24/ a 404, and the front page missing
# everything from 08-20 onward. Nothing malfunctioned. `check-code-drift.sh`
# printed its standard remediation, `deploy.sh all`, `all` was `deploy_code;
# deploy_site`, and deploy_site did exactly what it says — built 26 pages from a
# developer checkout and rsynced them over 43 pages of real content. The deploy
# reported success throughout; the post-deploy check caught it.
#
# deploy/README.md already warned that a laptop-built release lands with the
# wrong uid. The uid was never the sharp end: the content is.
deploy_site() {
	if [ -z "${CVT_ALLOW_LOCAL_BUILD:-}" ]; then
		echo "deploy: refusing to build the site on this machine." >&2
		echo "  The droplet holds content this checkout does not have: the queued," >&2
		echo "  held and rejected posts are gitignored, published briefs are too," >&2
		echo "  and content/published/ is written on the host at approval time. A" >&2
		echo "  build from here publishes a smaller, older site over the real one." >&2
		echo "  Rebuild on the host instead:" >&2
		echo "    $0 all              code + units, then a rebuild on the host" >&2
		echo "    ssh \$CVT_DEPLOY_HOST  and run: scripts/deploy.sh host-update" >&2
		echo "  (set CVT_ALLOW_LOCAL_BUILD=1 only if the host cannot build at all," >&2
		echo "   and expect to lose every post that exists only there.)" >&2
		exit 79
	fi
	echo "==> building the site LOCALLY (CVT_ALLOW_LOCAL_BUILD is set)"
	echo "    any post that exists only on the host will be published over." >&2
	# No CVT_SITE_ORIGIN override: astro.config.mjs already defaults to
	# https://chinovalley.today, which is what this host serves.
	(cd site && npm ci && npm run build)

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

	# Hand the release to the service account. rsync -a preserves the DEVELOPER
	# machine's numeric uid, so a release uploaded from a laptop lands owned by
	# whatever uid that user happens to be — 502 on macOS, which is nobody on
	# the droplet. The on-host prune runs as cvtoday and then cannot delete it,
	# so releases silently accumulate past the keep-5 policy. That already
	# happened: one directory got stuck and every subsequent `deploy.sh local`
	# printed "Permission denied" while still reporting success.
	ssh "$HOST" "chown -R cvtoday:cvtoday '$WEB/releases/$release'"

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
	# Repair ownership FIRST, while still root, then drop privileges.
	#
	# Order matters and is not cosmetic: this ran git and npm as root, so every
	# deploy rewrote the checkout as root — 4792 files by 2026-08-18, including
	# .git/FETCH_HEAD. Dropping to cvtoday without repairing first fails at the
	# very first `git fetch` with "cannot open '.git/FETCH_HEAD': Permission
	# denied", so the updater could never fix the state that blocks it. Doing
	# the chown here makes any host in that condition self-heal on the next
	# deploy rather than needing a human with root.
	#
	# Idempotent and cheap once converged: a no-op chown on an already-correct
	# tree.
	ssh "$HOST" "chown -R cvtoday:cvtoday '$APP'"

	# As cvtoday, NOT as root — the checkout belongs to the service account, and
	# the timers, the pipeline and CI's host-update path all run as it. Running
	# deploys as the owner keeps that consistent instead of quietly inverting it
	# one deploy at a time.
	ssh "$HOST" "cd '$APP' && sudo -u cvtoday bash -s" < "$ROOT/scripts/host-code-update.sh"

	# Verify CI's forced command, rather than rewriting it.
	#
	# The SSH command CI sends is ignored; only this entry decides what runs. If
	# it still says `local`, every push rebuilds the site from whatever code the
	# host already has and ships no pipeline change at all, while the workflow
	# reports success — the exact silent failure this work exists to end.
	#
	# Checked and failed, NOT auto-corrected, which is a deliberate departure
	# from the timer block below. Enabling a timer that should not run is
	# recoverable; a botched write to an SSH authorization file either locks CI
	# out or loosens a restriction, and that is not a thing to do as a side
	# effect of a routine deploy.
	echo "==> checking CI forced command"
	ssh "$HOST" "
		keys='$APP/.ssh/authorized_keys'
		want='$APP/scripts/deploy.sh host-update'

		# Absent key is a failure, not a note. A deploy that reports success
		# while no CI key exists is the same false all-clear as one reporting
		# success over the wrong forced command.
		if [ ! -f \"\$keys\" ]; then
			echo \"  ERROR: no \$keys — CI deploy key not provisioned\" >&2
			echo '    See deploy/README.md step 3b. Until then, pushes to main deploy nothing.' >&2
			exit 1
		fi

		# EVERY key line must carry the host-update forced command — not merely
		# one of them, and not merely 'a' forced command.
		#
		# Two holes this closes. A second restricted key still forcing \`local\`
		# would pass a check that only looked for the wanted string somewhere,
		# and we cannot tell from here which key GitHub's secret holds, so any
		# non-host-update entry might be the one CI uses. And a BARE key line —
		# no command= prefix — grants an unrestricted interactive shell as
		# cvtoday, which matters more since that account has /bin/bash: it needs
		# one to run a forced command at all, so the key file is the only thing
		# keeping it to a single command.
		lines=\"\$(grep -vE '^[[:space:]]*(#|\$)' \"\$keys\" || true)\"
		if [ -z \"\$lines\" ]; then
			echo \"  ERROR: \$keys has no key entries\" >&2
			exit 1
		fi
		# ANCHORED to the start of the line, and requiring no-port-forwarding.
		#
		# A substring search certifies a key that merely mentions the command in
		# its trailing COMMENT field — \`ssh-ed25519 AAAA... command=\"...\"\` — which
		# sshd ignores entirely, so that key still opens a shell. The options
		# must be the first thing on the line to mean anything.
		#
		# no-port-forwarding is checked because a forced command does NOT block
		# forwarding on its own: without it the key is a tunnel into a droplet
		# hosting four other people's sites, no matter what command it runs.
		bad=''
		while IFS= read -r line; do
			case \"\$line\" in
				\"command=\\\"\$want\\\"\",*no-port-forwarding*) continue ;;
			esac
			bad=\"\$bad\$line
\"
		done <<KEYS
\$lines
KEYS
		if [ -n \"\$bad\" ]; then
			echo '  ERROR: authorized_keys entry is not restricted to host-update' >&2
			printf '%s\n' \"\$bad\" | grep -v '^\$' | cut -c1-70 | sed 's/^/    now: /' >&2
			echo \"    want every line to BEGIN: command=\\\"\$want\\\",...,no-port-forwarding,...\" >&2
			echo '    A wrong command ships no code on push. A bare key, or one' >&2
			echo '    whose options sit in the comment field, is an unrestricted' >&2
			echo '    shell as cvtoday. Without no-port-forwarding the key is a' >&2
			echo '    tunnel into a shared droplet whatever command it runs.' >&2
			exit 1
		fi
		echo \"  forced command runs host-update (\$(printf '%s\n' \"\$lines\" | wc -l | tr -d ' ') key(s))\"
	"

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

	# No --silent. It hides npm's own failures: when node_modules was
	# root-owned, `npm ci` could not delete it, and all that reached the CI log
	# was "exit code 243" with not one line of explanation.
	(cd "$ROOT/site" && npm ci && npm run build)
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
	# A prune failure must be visible. `rm` inside a `while` loop reports through
	# the loop's exit status, which is the LAST iteration's, so a failed delete
	# vanished: the release stayed, the deploy printed "site live at ..." and
	# exited 0, and only a stray "Permission denied" on stderr hinted anything
	# was wrong. Releases then accumulate past the keep-5 policy on a 25GB disk,
	# which is the kind of thing noticed when it is already a problem.
	local prune_failed=0
	while read -r old; do
		rm -rf "${WEB:?}/releases/${old:?}" || {
			echo "deploy: could not remove old release $old" >&2
			prune_failed=1
		}
	done < <(find "$WEB/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' |
		sort -r | tail -n +6)
	if [ "$prune_failed" -ne 0 ]; then
		echo "deploy: old releases could not be pruned — check ownership under $WEB/releases" >&2
		echo "  (a release uploaded by \`deploy.sh site\` from a developer machine" >&2
		echo "   lands owned by that machine's uid unless chowned; see deploy_site)" >&2
		exit 73
	fi

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
	# Code and units from here, the rebuild on the host. `all` used to call
	# deploy_site, which is how a laptop's build reached the live site.
	all) deploy_code; rebuild_on_host ;;
	local) deploy_local ;;
	host-update) deploy_host_update ;;
	# Unreachable: the subcommand was validated at the top, before anything
	# that could need configuration. Kept so this dispatch cannot silently do
	# nothing if the two lists ever fall out of step.
	*) echo "usage: $0 <code|all|site|local|host-update>" >&2; exit 64 ;;
esac
