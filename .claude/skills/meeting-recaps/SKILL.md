---
name: meeting-recaps
description: Weekly meeting-recap pass on the droplet - pull the meeting transcripts the droplet is blocked from fetching, find meetings that are ready and have no recap yet, generate the recaps through the gated pipeline, then walk Rex through what to review (held drafts, gate failures, judge findings) and apply his approve/reject decisions and rebuild the site. Use when asked to run recaps, do the recap pass, or when the Friday "CVT: run meeting recaps" reminder fires.
---

# Meeting recaps: generate and review

Recaps (`src/pipeline/recap.ts`) have no timer. This skill is the weekly
manual pass. Friday is the target day, so what publishes lands in Monday's
podcast, which reviews posts published the week before.

Everything except the transcript recording (step 2) runs on the droplet,
against production data:

```bash
H=root@24.199.115.162
R=/srv/chino-valley-today
DB="sqlite3 -readonly $R/data/cvtoday.db"
```

Read with `sqlite3 -readonly`. Write only through `npm run recap` and the
admin endpoints below. Those move the post file and the DB row together.
Never `UPDATE posts` by hand.

## 1. Minutes first

Ask whether any new Chino Hills minutes are waiting. If so, run the
`chinohills-minutes` skill before continuing, so the minutes feed this pass.

## 2. Pull transcripts

YouTube (bot check) and Swagit (HTTP 403) block the droplet's IP, so the
daily `cvt-scrape-media` run fails and meetings get no transcript. Record
the three transcript scrapers on this Mac, then replay the recording on the
droplet (`src/replay.ts`). A temp DB and raw root keep the local
`data/` untouched and force a full fetch, because a local DB that already
holds a video would skip downloading it and record nothing.

```bash
cd /Users/rexl/Projects/chino-valley-today
T=$(mktemp -d); REC=$T/rec
for k in chinohills-swagit chino-youtube-captions youtube-captions; do
  CVT_DB=$T/rec.db CVT_RAW_ROOT=$T CVT_RECORD_DIR=$REC node src/run-one.ts $k | grep -E '^=== |^counts'
done
rsync -a --delete $REC/ $H:$R/data/incoming/replay/
ssh $H "chown -R cvtoday:cvtoday $R/data/incoming/replay"
for k in chinohills-swagit chino-youtube-captions youtube-captions; do
  ssh $H "cd $R && sudo -u cvtoday CVT_REPLAY_DIR=data/incoming/replay node src/run-one.ts $k" | grep -E '^=== |^counts'
done
rm -rf $T
```

The replay counts should match the recording's `itemsSeen`, and on the
droplet `itemsNew` is how many were actually new. A record-side failure
means the source is down from here too: report it and carry on without
that source. **Never put `CVT_REPLAY_DIR` in the droplet's `.env`.** The
timer failing is the only sign that this pull is still needed.

Coverage is what the scrapers pick, not a backfill: Swagit takes the newest
Chino Hills meeting with a transcript, Chino YouTube the two newest
meetings, CVUSD the newest board meeting. A meeting that falls out of that
window between passes stays without a transcript. Say so when a candidate
in step 3 is missing one.

## 3. Find what is ready

```bash
ssh $H "cd $R && sudo -u cvtoday npm run -s recap"
ssh $H "$DB \"SELECT slug, status, meeting_date FROM posts WHERE post_type='meeting_recap' ORDER BY meeting_date\""
```

A target's recap slug is `<date>-<bodyName lowercased, non-alphanumerics -> '-'>-recap`
(for example, `Chino Hills City Council Regular` on 2026-08-11 becomes
`2026-08-11-chino-hills-city-council-regular-recap`). A target is a
**candidate** when all of these hold:

- no post with that slug exists, in any status. `rejected` counts: someone decided.
- it has a record of what happened: `transcriptSegments > 0`, `votes > 0`, or
  `minutesItems > 0`. Agenda-only targets say only what was scheduled, so
  skip them and say so.
- `meeting_date` is within the last 45 days, unless Rex asks to backfill.

Show Rex a table: target, body, date, counts. Also list the skipped
agenda-only targets from the window. That list shows whether transcripts or
minutes are lagging, which is worth knowing even when nothing gets recapped.
**Ask which targets to run.** A clean pass auto-publishes, and every run
spends LLM calls.

## 4. Generate

Run the chosen targets one at a time. Each run takes several minutes, since
the generator and judge each have a 10-minute retry budget. Use
`run_in_background` and wait for the notification instead of polling:

```bash
ssh $H "cd $R && sudo -u cvtoday npm run -s recap -- <targetKey>"
```

The last line gives the outcome: `PUBLISHED (auto, clean pass)` or held. A
non-zero exit that is not a hold (LLM outage, timeout) gets reported as a
failure. Leave that target for the next pass, because no post was created.

## 5. Prompt Rex on what to review

Pull every held recap, including ones from earlier passes that nobody
reviewed:

```bash
ssh $H "$DB -json \"SELECT slug, tier, held_reason, gates, judge, file_path FROM posts WHERE post_type='meeting_recap' AND status='held'\""
ssh $H "cat $R/<file_path>"   # the draft itself
```

For each held draft, give Rex a short brief, not the raw JSON:

- **Why it was held:** `held_reason` in one line.
- **Gate 1 failures:** each `gates.failures[]` as gate, detail, and the
  `excerpt`, quoted with its line from the draft. Say what the gate caught.
  Examples: a `proper_names` failure on "Adoption of Resolution" is a
  Title-Case agenda phrase, not a person. An ASR-garbled name is a real
  problem.
- **Judge findings** (if `judge` is non-null): each claim with verdict
  `unsupported` or `distorted`, with its `reason` and `source_url`, plus any
  `flags` that are true and the `reasons`.
- **What to check:** 1 to 3 concrete things to verify before approving, each
  pointing at the source URL. Say whether each failure is a false alarm or a
  real error in the draft, and why.
- **Tier C:** if `tier` is `C`, say so first. It names private individuals
  and needs the EDITORIAL.md acknowledgment to approve.

Then ask for a decision on each: **approve**, **reject**, or **leave held**.
Offer a clean regenerate if a failure is a real error. That means rejecting
this draft and noting the target for a manual fix, because a rejected slug
blocks a re-run.

For recaps that auto-published this pass, list them with their URLs
(`https://chinovalley.today/posts/<slug>/`) and suggest a 2-minute skim of
each. Nothing blocks, but a clean pass is still unreviewed by a person.

## 6. Apply decisions

Only what Rex decided, one post at a time. The admin server listens on the
droplet's loopback, so call it from there:

```bash
A="curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: http://127.0.0.1:8788'"
ssh $H "$A http://127.0.0.1:8788/posts/<slug>/approve"
ssh $H "$A http://127.0.0.1:8788/posts/<slug>/reject"
```

The `Origin` header is required. The dashboard's `csrf()` middleware returns
403 on a form POST without a matching one.

`303` means done. For a Tier C approve, add `-d ack=1`, and only after Rex has
explicitly given the acknowledgment for that post. Anything other than `303`
is an error: show the body (drop `-o /dev/null`) and stop.

Rex can do the same in the dashboard instead:
`ssh -N -L 8788:127.0.0.1:8788 root@24.199.115.162`, then open
http://127.0.0.1:8788.

## 7. Rebuild and report

If anything published (auto or approved):

```bash
ssh $H "cd $R && sudo -u cvtoday bash scripts/deploy.sh local"
```

Report: recapped, auto-published, approved, rejected, left held, and the
agenda-only meetings still waiting on a transcript, votes, or minutes.
