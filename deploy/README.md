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

# 4. restic, for the offsite backup.
apt-get update && apt-get install -y restic
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

Two setup steps are easy to miss because they are not variables:

```bash
# 1. The restic password is a FILE, not a value in .env.
printf '%s' '<long random passphrase>' > /srv/chino-valley-today/.restic-password
chmod 600 /srv/chino-valley-today/.restic-password
chown cvtoday:cvtoday /srv/chino-valley-today/.restic-password

# 2. Also keep that passphrase in a password manager. It cannot live only in
#    the bucket it protects, and restic has no recovery path without it.
```

Give the droplet a B2 application key scoped to that one bucket, with
**write but not delete** capability. A compromised droplet then cannot destroy
backup history, which is most of the point of holding it offsite. Pruning needs
delete rights, so run it deliberately from a trusted machine:

```bash
CVT_BACKUP_PRUNE=1 scripts/backup-b2.sh
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

### DNS

`chinovalley.today` must resolve to the droplet **before** the Caddy block
is enabled, or ACME fails in a retry loop.

In Cloudflare, add an `A` record for `@` (and `www`) pointing at the droplet,
set to **DNS-only — the grey cloud, not proxied**. A proxied record makes
Cloudflare terminate TLS, and Caddy's HTTP-01 challenge never reaches the
origin.

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
| `cvt-scrape-frequent` | hourly at :17 | news RSS, NWS alerts, sheriff, Nixle mail |
| `cvt-scrape-daily` | 05:40 | Legistar, Agenda Center, AgendaQuick, CVUSD, ABC |
| `cvt-scrape-media` | 07:30 | Swagit video, YouTube captions |
| `cvt-backup` | 02:20 | restic → B2 |

Schedules are Pacific because meeting times are; systemd 255 on Ubuntu 24.04
accepts a timezone directly in `OnCalendar`. All are `Persistent=true`, so a
run missed during a reboot fires once afterwards instead of being skipped.

```bash
systemctl enable --now cvt-scrape-frequent.timer cvt-scrape-daily.timer \
                       cvt-scrape-media.timer cvt-backup.timer
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

## Health check

```bash
systemctl list-timers 'cvt-*'                        # next/last run of each
systemctl --failed | grep cvt                        # anything broken
journalctl -u cvt-scrape-frequent --since '24h ago'  # recent frequent runs
restic snapshots --tag cvtoday --latest 5            # backups actually landing
curl -sI https://chinovalley.today | head -1         # site answering
free -m                                              # headroom vs the other sites
```
