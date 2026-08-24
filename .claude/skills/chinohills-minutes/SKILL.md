---
name: chinohills-minutes
description: Stage hand-downloaded Chino Hills meeting minutes PDFs into the pipeline - inspect, rename to the canonical drop name, ship to the droplet, and ingest. Use after downloading minutes from the Laserfiche portal, or when asked to ingest, stage, or process Chino Hills minutes.
---

# Chino Hills minutes: stage and ingest

Takes minutes PDFs a person downloaded by hand and carries them the rest of the
way: inspect, rename, stage, ship to the droplet, ingest, report.

## The one thing this skill does not do

**Never download from `publicportal.chinohills.org`.** That host's robots.txt
disallows `/*.aspx`, which is every document URL it has. Retrieving from it
programmatically is what this whole drop-directory arrangement exists to avoid.

A person downloads through a browser, where robots.txt does not apply. This
skill starts from files already on disk. If the user has not downloaded
anything yet, give them the folder links and stop:

| Body | Minutes folder |
|---|---|
| City Council | `https://publicportal.chinohills.org/WebLink/Browse.aspx?startid=66925` |
| Parks & Recreation Commission | `.../Browse.aspx?id=175253&dbid=0&repo=CoCH` |
| Planning Commission | `.../Browse.aspx?id=3943&dbid=0&repo=CoCH` |
| Public Works Commission | `.../Browse.aspx?id=303105&dbid=0&repo=CoCH` |
| Employee Deferred Compensation Cttee | `.../Browse.aspx?id=341392&dbid=0&repo=CoCH` |
| Legislative Advocacy Committee | `.../Browse.aspx?id=150216&dbid=0&repo=CoCH` |
| Public Art Committee | `.../Browse.aspx?id=348679&dbid=0&repo=CoCH` |
| Tres Hermanos JPA | `.../Browse.aspx?id=220589&dbid=0&repo=CoCH` |

If the City later grants automated access, this section is what changes.

## Steps

### 1. Find the candidates

Default to PDFs modified in the last day in `~/Downloads`. The user may pass a
different path or specific files instead.

```bash
find ~/Downloads -maxdepth 1 -iname '*.pdf' -mtime -1 -print
```

Report what you found. If nothing, say so and stop.

### 2. Inspect, and propose names

```bash
cd /Users/rexl/Projects/chino-valley-today
node --experimental-strip-types scripts/inspect-minutes-pdf.ts <file> [<file> ...]
```

One JSON line per file: `date`, `body`, `suggested`, `confidence`, `firstLines`.
It reads the document's own text rather than trusting WebLink's filename.

### 3. Confirm before renaming

Show the user a table of `original -> suggested`, with the confidence and the
detected first lines for anything not `high`.

**Ask for confirmation.** Do not skip this. A wrong name files minutes under
the wrong meeting, which puts a false entry in a record whose whole promise is
that every claim traces to its source. A missing file is recoverable; a
mis-filed one is not, because nothing downstream will flag it.

For any file where `suggested` is null, ask the user for the body and date
rather than guessing. Valid body slugs are the eight in the table above.

### 4. Stage

```bash
mkdir -p data/incoming/chinohills-minutes
cp '<original>' 'data/incoming/chinohills-minutes/<suggested>'
```

Copy, do not move: leave the user's download untouched until ingest succeeds.
The directory is gitignored (`data/`), so nothing here is committed.

### 5. Ship to the droplet

```bash
rsync -av -e ssh data/incoming/chinohills-minutes/ \
  root@24.199.115.162:/srv/chino-valley-today/data/incoming/chinohills-minutes/
ssh root@24.199.115.162 'chown -R cvtoday:cvtoday /srv/chino-valley-today/data/incoming'
```

The chown matters: the pipeline runs as `cvtoday` and files arriving as root
are unreadable to it. This is the same ownership trap `deploy.sh` documents.

### 6. Ingest

```bash
ssh root@24.199.115.162 \
  'cd /srv/chino-valley-today && sudo -u cvtoday npm run one chinohills-minutes'
```

The scraper is content-addressed, so re-running over files already ingested is
a no-op. Re-shipping a whole year is safe.

**A non-zero exit means files were rejected**, and the error names each one and
why. Do not treat that as success. Common causes:

- `not a PDF` - the download saved an error page or was truncated. Re-download.
- `refusing to file minutes under the wrong meeting` - the filename's date
  contradicts the document text. The rename in step 3 was wrong.
- `unknown body` - the slug is not one of the eight.
- `filename does not match` - the rename did not happen or was malformed.

Fix and re-run. The scraper ingests every good file even when others fail, so a
re-run only has to clear the rejects.

### 7. Report

State plainly:

- how many PDFs were present, newly archived, already held, rejected
- how many new items were extracted
- anything the scraper noted, particularly `no numbered items were parsed`
  (archived and linked, but no item breakdown) or `no date found in the
  document text` (the date rests on the filename alone)

The item splitter is deliberately conservative and **has not been validated
against a real Chino Hills minutes PDF** - there was no permitted way to fetch
one, so it was built against synthetic fixtures. On the first real drop, spot
check the item count and titles against the document and say what you find. The
document is archived and linked correctly regardless of how the split does.

## Notes

- Local ingest works too, without the droplet, for checking a parse before
  shipping: `npm run one chinohills-minutes` from the repo root.
- Override the drop location with `CVT_MINUTES_DROP_DIR`.
- The scraper also runs in the `daily` group, so files left in the drop are
  picked up within a day even if this skill is never run.
- Minutes appear days to weeks after a meeting. An empty drop is the normal
  state, not a problem.
