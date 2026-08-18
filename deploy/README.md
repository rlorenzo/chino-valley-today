# Droplet deployment

The pipeline and the public site both run on an existing DigitalOcean droplet
(Ubuntu 24.04, 1GB/25GB). The target host itself is configured in
`deploy/deploy.env`, which is gitignored — see `deploy/deploy.env.example` for
why no address appears in tracked files.

**That droplet is shared.** It already serves four other unrelated
production sites, all as Caddy `reverse_proxy` blocks to local
ports. Everything here is written to be additive and to fail safe, because a
mistake takes those four sites down too. Two consequences worth knowing before
changing anything:

- The Caddy edit is **manual and separate from the deploy script**, so a config
  error can never ride along with a routine site push.
- Every systemd unit sets `MemoryMax`, `Nice` and `IOSchedulingClass=idle`. The
  box has ~480MB free plus 2GB swap; a runaway scrape gets killed by the kernel
  rather than taking the interactive sites with it.

The admin dashboard runs on **8788, not its 8787 default** — another service already
holds 8787.

## Layout

| Path | What |
| --- | --- |
| `/srv/chino-valley-today` | pipeline checkout, owned by `cvtoday` |
| `/srv/chino-valley-today/.env` | secrets, `chmod 600`, never in git |
| `/srv/chino-valley-today/data` | SQLite DB and the raw archive |
| `/var/www/chinovalley.today/releases/<ts>` | published site builds |
| `/var/www/chinovalley.today/current` | symlink to the live release |

## One-time provisioning

```bash
# 1. Service account. --system, no login shell: this account exists to own
#    files and run timers, never to be logged into.
adduser --system --group --home /srv/chino-valley-today --shell /usr/sbin/nologin cvtoday

# 2. Checkout. The repo is public, so no deploy key is needed.
git clone https://github.com/rlorenzo/chino-valley-today.git /srv/chino-valley-today
chown -R cvtoday:cvtoday /srv/chino-valley-today
sudo -u cvtoday npm ci --omit=dev --prefix /srv/chino-valley-today

# 3. Web root.
mkdir -p /var/www/chinovalley.today/releases
chown -R cvtoday:cvtoday /var/www/chinovalley.today

# 4. rclone, for the offsite backup. Already present on this host for the
#    other projects' backups; listed for a clean rebuild.
apt-get update && apt-get install -y rclone

# 5. yt-dlp, for the YouTube caption scrapers. NOT from apt — Ubuntu ships a
#    stale build and YouTube changes break old versions regularly. The official
#    standalone binary self-updates with `yt-dlp -U`. Without it, both YouTube
#    scrapers fail with ENOENT and the media group exits non-zero.
curl -fsSL -o /usr/local/bin/yt-dlp \\
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod 755 /usr/local/bin/yt-dlp
```

### Secrets

`.env` is never in git and never deployed by the script. Copy it up once, then
keep it there:

```bash
scp .env $CVT_DEPLOY_HOST:/srv/chino-valley-today/.env
ssh $CVT_DEPLOY_HOST 'chown cvtoday:cvtoday /srv/chino-valley-today/.env && chmod 600 /srv/chino-valley-today/.env'
```

**`.env.example` is the authoritative list of every variable**, with what each
one is for and how to obtain it — this file does not repeat them, so the two
cannot drift apart. The droplet needs the existing pipeline keys plus the
`RESTIC_*` and `B2_*` block.

Backups follow the **same pattern as Rush Call, SpotTheStar and foreshock**:
`sqlite3 .backup` + gzip, 14 local snapshots, `rclone copy` to a per-project B2
bucket, 14 remote. One restore procedure across every project, which is what
matters when restoring under stress.

Create a dedicated bucket and a **bucket-scoped Read/Write** application key,
isolated from the other projects', then write the rclone config:

```bash
rclone config            # remote type: b2, name it "b2"
mv ~/.config/rclone/rclone.conf /srv/chino-valley-today/rclone.conf
chown cvtoday:cvtoday /srv/chino-valley-today/rclone.conf
chmod 600 /srv/chino-valley-today/rclone.conf
```

The credentials live only in that file, never in `.env` — same as the other
three projects.

**`.env` is deliberately not backed up.** rclone copies to B2 unencrypted, and
it holds the DO Inference key and the Gmail app password; both are reissuable
from their consoles, while the archive is not. This matches the other projects,
which also keep credentials on the box and out of the snapshot.

**The raw archive is mirrored, not snapshotted.** `data/raw` is ~104MB of
content-addressed documents, so `rclone copy` uploads only files it does not
already have — tarring it nightly would push the whole thing every run. It is
copied with `copy` and never `sync`, so a local deletion can never propagate
offsite.

Restore:

```bash
rclone --config /srv/chino-valley-today/rclone.conf copy b2:chinovalley.today-backup/cvtoday-<date>.db.gz .
gunzip cvtoday-<date>.db.gz
sqlite3 cvtoday-<date>.db "PRAGMA integrity_check;"   # expect: ok
systemctl stop cvt-admin
mv cvtoday-<date>.db /srv/chino-valley-today/data/cvtoday.db
systemctl start cvt-admin
```

### Data migration

The existing archive moves up once (~99MB, and the 25GB disk is 33% used):

```bash
rsync -avz --progress data/raw/ $CVT_DEPLOY_HOST:/srv/chino-valley-today/data/raw/
sqlite3 data/cvtoday.db ".backup '/tmp/cvtoday.db'"   # WAL-safe, never cp a live DB
scp /tmp/cvtoday.db $CVT_DEPLOY_HOST:/srv/chino-valley-today/data/cvtoday.db
rsync -avz content/ $CVT_DEPLOY_HOST:/srv/chino-valley-today/content/
ssh $CVT_DEPLOY_HOST 'chown -R cvtoday:cvtoday /srv/chino-valley-today/data /srv/chino-valley-today/content'
```

### DNS and TLS

`chinovalley.today` and `www` are `A` records pointing at the droplet, **proxied
(orange cloud)**. That is deliberate: the proxy hides the origin address, which
matters because this repo is public, and it brings caching and DDoS absorption.

Keeping the proxy on rules out Caddy's automatic Let's Encrypt issuance —
TLS-ALPN-01 is terminated at Cloudflare's edge and never reaches Caddy. So TLS
uses a **Cloudflare Origin CA certificate** instead: free, valid up to 15 years,
trusted by Cloudflare specifically, and served directly by Caddy. No ACME, no
renewal job, no custom Caddy build, and the proxy is never switched off.

1. Cloudflare → SSL/TLS → **Origin Server** → Create Certificate. Hostnames
   `chinovalley.today` and `*.chinovalley.today`. Leave the default key type.
2. Install both halves on the droplet, owner-only:

   ```bash
   install -d -m 700 -o caddy -g caddy /etc/caddy/certs
   nano /etc/caddy/certs/chinovalley.today.pem    # paste the certificate
   nano /etc/caddy/certs/chinovalley.today.key    # paste the private key
   chmod 600 /etc/caddy/certs/chinovalley.today.*
   chown caddy:caddy /etc/caddy/certs/chinovalley.today.*
   ```

3. Cloudflare → SSL/TLS → Overview → set encryption mode to **Full (strict)**.

   Not **Flexible**: it reaches the origin over plain HTTP while Caddy redirects
   HTTP to HTTPS, producing an infinite redirect loop. Not **Full**: it accepts
   any origin certificate, so it verifies nothing.

The Origin CA certificate is trusted only by Cloudflare, by design. Hitting the
origin address directly will show a certificate warning — that is expected.

### Caddy

Append `deploy/Caddyfile.chinovalley.today` to `/etc/caddy/Caddyfile`, then:

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak     # the four other sites live here
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy                                # reload is graceful; restart is not
```

If `validate` fails, fix it before reloading — the running config stays live
until a successful reload, so a failed validate costs nothing.

## Deploying

From a developer machine:

```bash
scripts/deploy.sh site    # build and publish the static site
scripts/deploy.sh code    # update the checkout, deps, and systemd units
scripts/deploy.sh all
```

Site releases are published by swapping the `current` symlink, so a reader
always sees a whole release and never a half-synced one. The last 5 are kept;
rollback is a swap:

```bash
ssh $CVT_DEPLOY_HOST 'ls -1t /var/www/chinovalley.today/releases'
ssh $CVT_DEPLOY_HOST 'ln -sfnT /var/www/chinovalley.today/releases/<ts> /var/www/chinovalley.today/current.new && mv -T /var/www/chinovalley.today/current.new /var/www/chinovalley.today/current'
```

## Timers

| Unit | Schedule (Pacific) | Sources |
| --- | --- | --- |
| `cvt-scrape-frequent` | hourly at :17 | news RSS, NWS alerts + forecast, fire feeds, sheriff, Nixle mail |
| `cvt-scrape-daily` | 05:40 | Legistar, Agenda Center, AgendaQuick, CVUSD, ABC, event calendars |
| `cvt-tiera` | 05:50 | *not a scrape* — generates + publishes Tier A posts, rebuilds the site |
| `cvt-scrape-media` | 07:30 | Swagit video, YouTube captions |
| `cvt-brief` | 06:00 | daily brief assembly + site rebuild (no scraping) |
| `cvt-brief-watch` | 08:00 | flips `/health` to `pipeline=stale` if today's brief is missing |
| `cvt-backup` | 02:20 | rclone → B2 |

`cvt-tiera` is the only unit here that publishes rather than ingests. It exists
because `src/tiera/run.ts` previously had no caller anywhere in `deploy/`,
`scripts/` or `.github/`: the generators ran only when someone typed
`npm run tiera`, so on the droplet the scrapers filled the database every hour
and nothing was ever published from it. It sits between the 05:40 daily scrape
and the 06:00 brief on purpose: it generates against fresh data, and the brief
then assembles against Tier A posts that already exist.

Schedules are Pacific because meeting times are; systemd 255 on Ubuntu 24.04
accepts a timezone directly in `OnCalendar`. All are `Persistent=true`, so a
run missed during a reboot fires once afterwards instead of being skipped.

```bash
systemctl enable --now cvt-scrape-frequent.timer cvt-scrape-daily.timer \
                       cvt-tiera.timer cvt-scrape-media.timer cvt-brief.timer \
                       cvt-brief-watch.timer cvt-backup.timer
systemctl enable --now cvt-admin.service

systemctl list-timers 'cvt-*'
journalctl -u cvt-scrape-daily -n 50
systemctl start cvt-scrape-daily.service   # run one now, without waiting
```

## Admin dashboard

The dashboard binds `127.0.0.1` and is **not exposed through Caddy**. Reach it
over a tunnel:

```bash
ssh -N -L 8788:127.0.0.1:8788 $CVT_DEPLOY_HOST
# then open http://127.0.0.1:8788
```

This departs from PLAN.md's "Caddy basic auth" deliberately. The dashboard
approves and publishes posts, so a brute-forced or leaked basic-auth password
is a publishing compromise — and basic auth offers no rate limiting, no MFA and
no audit trail. If the convenience ever outweighs that, the block is:

```caddyfile
admin.chinovalley.today {
	basic_auth {
		# caddy hash-password --plaintext '<password>'
		rex <bcrypt-hash>
	}
	reverse_proxy localhost:8788
}
```

## Monitoring

Two different things fail here, and only one of them is what a normal uptime
check finds.

### Site liveness — `https://chinovalley.today/health`

Plain text, keyword `ok` on the first line. Matches the foreshock pattern:
UptimeRobot HTTP(s) monitor, keyword `ok`, 5-minute interval.

```text
ok
built=2026-08-17T17:07:50.752Z
posts=9
latest_post=2026-08-15
```

This proves the droplet is up, Caddy is running, TLS is valid and the release
symlink resolves. Caddy sets `Cache-Control: no-store` on it, because a cached
`ok` outlives the thing it reports on.

### Pipeline liveness — the check that actually matters

**A bare `ok` on `/health` cannot tell you the pipeline is alive.** The site
is static: if every scrape timer died tonight, `/health` would keep answering
`ok` while the site served a frozen record, and nothing would alert. For a
publication whose claim is currency, silently going stale is a worse failure
than visibly going down — nobody is paged by content that simply stops
changing. Two ways to close that gap, by plan tier:

#### Free plan: keyword monitor on `pipeline=fresh`

`/health` carries a `pipeline=fresh|stale` line. It is stamped at build time
(fresh only when the latest brief is the one that build moment may fairly
expect — today's after 07:00 Pacific, yesterday's before), and
`cvt-brief-watch.timer` (08:00 Pacific) rewrites the **live** file to
`pipeline=stale` when today's brief has not published — covering the case
where no rebuild happened at all.

Create a keyword monitor on `https://chinovalley.today/health` with keyword
`pipeline=fresh`, configured to alert when the keyword is **absent**. One
monitor then fires on: a missed or failed morning brief, a mangled health
page, and the site being down outright.

Residual blind spot, recorded honestly: systemd's timers dying wholesale
(the watchdog included) while Caddy keeps serving. Only the heartbeat scheme
below catches that; the keyword monitor is the free-plan approximation, and
the plain `ok` uptime check still covers the host itself going down.

#### Paid plan (or healthchecks.io): dead-man's-switch heartbeats

The check is inverted. Each scrape group pings a dead-man's-switch URL after
a clean run, and the monitoring service alerts when the ping **stops arriving**.
Create UptimeRobot *heartbeat* monitors (or healthchecks.io checks) and
set them in `.env`:

| Variable | Group schedule | Suggested period |
| --- | --- | --- |
| `CVT_HEARTBEAT_URL_FREQUENT` | hourly at :17 | 90 min |
| `CVT_HEARTBEAT_URL_DAILY` | 05:40 Pacific | 30 h |
| `CVT_HEARTBEAT_URL_MEDIA` | 07:30 Pacific | 30 h |
| `CVT_HEARTBEAT_URL_BRIEF` | 06:00 Pacific | 30 h |

Unset means no ping and no alarm, which is the right default on a developer
machine. A failed ping never fails the scrape run itself.

### Immediate failure detail

Heartbeats tell you something stopped; they do not say what. For that, hang an
`OnFailure=` unit on the timers to push to the same ntfy topic foreshock uses:

```ini
# /etc/systemd/system/cvt-notify@.service
[Unit]
Description=Notify on failure of %i

[Service]
Type=oneshot
EnvironmentFile=/srv/chino-valley-today/.env
ExecStart=/usr/bin/curl -fsS -H "Title: %i failed" -d "check: journalctl -u %i -n 50" ${NTFY_TOPIC_URL}
```

Then add `OnFailure=cvt-notify@%n.service` to each `cvt-scrape-*.service` and
`cvt-backup.service`.

## Health check

```bash
systemctl list-timers 'cvt-*'                        # next/last run of each
systemctl --failed | grep cvt                        # anything broken
journalctl -u cvt-scrape-frequent --since '24h ago'  # recent frequent runs
rclone --config /srv/chino-valley-today/rclone.conf lsf b2:chinovalley.today-backup  # backups landing
curl -sI https://chinovalley.today | head -1         # site answering
free -m                                              # headroom vs the other sites
```
