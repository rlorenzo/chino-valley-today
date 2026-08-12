// The admin dashboard: single page, four sections (published feed, held
// queue, audit queue, pipeline health), form-posted actions. See
// reports/notes/phase1-admin.md for the full spec-to-implementation mapping.
//
// CSRF is explicitly out of scope: this binds 127.0.0.1 only and will sit
// behind Caddy basic auth in a later phase (PLAN.md Phase 1 Mechanics).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Db } from '../db/index.ts';
import { getPost, listPosts, transitionPost, type PostRow } from '../pipeline/posts.ts';
import { ROOT } from '../store.ts';
import { esc, layout, parsePostFile, renderJsonReasons, renderMarkdown, summarizeJudge, tierBadge } from './render.ts';
import { AUDIT_RATE, currentWeekStartIso, isSampledForAudit, isoWeekString, rollingFailCounts } from './audit.ts';

function readPostBody(post: PostRow): string {
  const abs = join(ROOT, post.file_path);
  if (!existsSync(abs)) return '_(file missing at expected path — DB/filesystem are out of sync)_';
  return readFileSync(abs, 'utf8');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// --- Section a: Published feed ----------------------------------------------

function renderPublished(db: Db): string {
  const posts = listPosts(db, 'published').sort((a, b) =>
    (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at)
  );
  if (posts.length === 0) return '<p class="muted">Nothing published yet.</p>';
  const rows = posts
    .map((p) => {
      const parsed = parsePostFile(readPostBody(p));
      const { score, flags } = summarizeJudge(p.judge);
      return `<tr>
        <td>${esc((p.published_at ?? p.created_at).slice(0, 16).replace('T', ' '))}</td>
        <td><a href="/posts/${encodeURIComponent(p.slug)}/view">${esc(parsed.title || p.slug)}</a></td>
        <td>${tierBadge(p.tier)}</td>
        <td>${esc(p.post_type)}</td>
        <td>${score == null ? '<span class="muted">n/a</span>' : esc(score)}</td>
        <td>${
          flags.length
            ? flags.map((f) => `<span class="badge badge-fail">${esc(f)}</span>`).join(' ')
            : '<span class="muted">none</span>'
        }</td>
        <td>${p.source_count ?? '<span class="muted">?</span>'}</td>
      </tr>`;
    })
    .join('\n');
  return `<table>
    <tr><th>Published</th><th>Title</th><th>Tier</th><th>Type</th><th>Judge score</th><th>Flags</th><th>Sources</th></tr>
    ${rows}
  </table>`;
}

// --- Section b: Held queue ---------------------------------------------------

function renderHeld(db: Db): string {
  const posts = listPosts(db, 'held');
  if (posts.length === 0) return '<p class="muted">Held queue is empty.</p>';
  return posts
    .map((p) => {
      const raw = readPostBody(p);
      const parsed = parsePostFile(raw);
      const ackBlock =
        p.tier === 'C'
          ? `<label class="ack"><input type="checkbox" name="ack" value="1" required> I have reviewed this item naming private individuals</label>`
          : '';
      return `<div class="card">
        <h3>${esc(parsed.title || p.slug)} ${tierBadge(p.tier)} <span class="muted">${esc(p.post_type)}</span></h3>
        <p><b>slug:</b> <code>${esc(p.slug)}</code> &middot; <b>held reason:</b> ${esc(p.held_reason ?? '(none recorded)')}</p>
        ${renderJsonReasons('Gate 1 — validators', p.gates)}
        ${renderJsonReasons('Gate 2 — judge', p.judge)}
        <h4>Draft</h4>
        <div class="draft">${renderMarkdown(parsed.body)}</div>
        <div class="actions">
          <form class="inline" method="post" action="/posts/${encodeURIComponent(p.slug)}/approve">
            ${ackBlock}
            <button type="submit" class="approve">Approve &rarr; publish</button>
          </form>
          <form class="inline" method="post" action="/posts/${encodeURIComponent(p.slug)}/reject">
            <button type="submit" class="reject">Reject</button>
          </form>
        </div>
      </div>`;
    })
    .join('\n');
}

// --- Section c: Audit queue ---------------------------------------------------

interface AuditLogRow {
  verdict: string;
  notes: string | null;
  audited_at: string;
}

function renderAudit(db: Db): string {
  const week = isoWeekString();
  // Universe = Tier B, currently published via the AUTO path (published_via
  // column; the approve handler stamps 'manual'). Legacy rows from before the
  // column existed have NULL — those were all auto-published, so include them.
  const candidates = db.raw
    .prepare(
      `SELECT * FROM posts WHERE tier = 'B' AND status = 'published'
       AND (published_via = 'auto' OR published_via IS NULL)`
    )
    .all() as unknown as PostRow[];
  const sampled = candidates.filter((p) => isSampledForAudit(p.slug, week));

  const failCounts = rollingFailCounts(db, 30);
  const postTypes = Array.from(
    new Set(
      (
        db.raw.prepare(`SELECT DISTINCT post_type FROM posts WHERE tier = 'B'`).all() as Array<{
          post_type: string;
        }>
      ).map((r) => r.post_type)
    )
  );
  const failSummary = postTypes.length
    ? `<h4>Rolling 30-day fail count by post type</h4><table><tr><th>post_type</th><th>fails (30d)</th><th></th></tr>${postTypes
        .map((t) => {
          const n = failCounts.get(t) ?? 0;
          return `<tr><td>${esc(t)}</td><td>${n}</td><td>${
            n >= 2
              ? '<span class="badge badge-warn">2+ fails this month — demote to held-by-default (PLAN Gate 3)</span>'
              : ''
          }</td></tr>`;
        })
        .join('')}</table>`
    : '';

  if (sampled.length === 0) {
    return `<p class="muted">Sample rate ${(AUDIT_RATE * 100).toFixed(0)}%, ISO week ${esc(
      week
    )}. Nothing sampled from the current auto-published Tier B set (${candidates.length} eligible).</p>${failSummary}`;
  }

  const rows = sampled
    .map((p) => {
      const existing = db.raw
        .prepare(`SELECT verdict, notes, audited_at FROM audit_log WHERE post_id = ? AND iso_week = ?`)
        .get(p.id, week) as AuditLogRow | undefined;
      const parsed = parsePostFile(readPostBody(p));
      if (existing) {
        return `<tr>
          <td><a href="/posts/${encodeURIComponent(p.slug)}/view">${esc(parsed.title || p.slug)}</a></td>
          <td>${esc(p.post_type)}</td>
          <td><span class="badge ${
            existing.verdict === 'pass' ? 'badge-pass' : 'badge-fail'
          }">${esc(existing.verdict.toUpperCase())}</span> — done ${esc(existing.audited_at.slice(0, 16).replace('T', ' '))}</td>
          <td>${esc(existing.notes ?? '')}</td>
        </tr>`;
      }
      return `<tr>
        <td><a href="/posts/${encodeURIComponent(p.slug)}/view">${esc(parsed.title || p.slug)}</a></td>
        <td>${esc(p.post_type)}</td>
        <td colspan="2">
          <form method="post" action="/audit/${encodeURIComponent(p.slug)}" class="actions">
            <input type="text" name="notes" placeholder="notes (optional)">
            <button type="submit" name="verdict" value="pass" class="pass">Pass</button>
            <button type="submit" name="verdict" value="fail" class="fail">Fail</button>
          </form>
        </td>
      </tr>`;
    })
    .join('\n');

  return `<p class="muted">Sample rate ${(AUDIT_RATE * 100).toFixed(0)}%, seeded by ISO week ${esc(
    week
  )} (hash of slug+week — stable all week). ${sampled.length} of ${candidates.length} eligible auto-published Tier B posts sampled this week.</p>
  <table><tr><th>Title</th><th>Type</th><th colspan="2">Verdict</th></tr>${rows}</table>
  ${failSummary}`;
}

// --- Section d: Pipeline health ------------------------------------------------

interface PocRunResult {
  key: string;
  ok: boolean;
  implemented: boolean;
  error?: string;
  durationMs: number;
}

function renderPipelineHealth(db: Db): string {
  const sources = db.raw
    .prepare(
      `SELECT s.key as key, s.name as name, MAX(d.fetched_at) as last_fetched
       FROM sources s LEFT JOIN documents d ON d.source_id = s.id
       GROUP BY s.id ORDER BY s.key`
    )
    .all() as Array<{ key: string; name: string; last_fetched: string | null }>;

  const weekStart = currentWeekStartIso();
  const weekCounts = db.raw
    .prepare(
      `SELECT s.key as key, COUNT(*) as cnt
       FROM documents d JOIN sources s ON d.source_id = s.id
       WHERE d.fetched_at >= ?
       GROUP BY s.id`
    )
    .all(weekStart) as Array<{ key: string; cnt: number }>;
  const weekMap = new Map(weekCounts.map((r) => [r.key, r.cnt]));

  const dataPath = join(ROOT, 'reports', 'poc-data.json');
  let runData: { ranAt: string; results: PocRunResult[] } | null = null;
  if (existsSync(dataPath)) {
    try {
      runData = JSON.parse(readFileSync(dataPath, 'utf8')) as { ranAt: string; results: PocRunResult[] };
    } catch {
      runData = null;
    }
  }
  const runByKey = new Map((runData?.results ?? []).map((r) => [r.key, r]));

  const rows = sources
    .map((s) => {
      const run = runByKey.get(s.key);
      const status = !run
        ? '<span class="muted">no run data</span>'
        : !run.implemented
          ? '<span class="muted">not implemented</span>'
          : run.ok
            ? '<span class="badge badge-pass">OK</span>'
            : `<span class="badge badge-fail">FAILED</span> ${esc(run.error ?? '')}`;
      return `<tr>
        <td>${esc(s.key)}</td>
        <td>${esc(s.name)}</td>
        <td>${s.last_fetched ? esc(s.last_fetched) : '<span class="muted">never</span>'}</td>
        <td>${weekMap.get(s.key) ?? 0}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('\n');

  return `<p class="muted">Last scraper run recorded: ${
    runData ? esc(runData.ranAt) : 'no reports/poc-data.json found'
  }</p>
  <table><tr><th>Source</th><th>Name</th><th>Last fetched_at</th><th>Documents this ISO week</th><th>Last run status</th></tr>${rows}</table>`;
}

// --- App -----------------------------------------------------------------------

export function createApp(db: Db) {
  const app = new Hono();

  app.get('/', (c) => {
    const body = `
      <h1>Chino Valley Today — Admin</h1>
      <nav>
        <a href="#published">Published</a>
        <a href="#held">Held</a>
        <a href="#audit">Audit</a>
        <a href="#health">Pipeline health</a>
      </nav>
      <h2 id="published">Published feed</h2>
      ${renderPublished(db)}
      <h2 id="held">Held queue</h2>
      ${renderHeld(db)}
      <h2 id="audit">Audit queue</h2>
      ${renderAudit(db)}
      <h2 id="health">Pipeline health</h2>
      ${renderPipelineHealth(db)}
    `;
    return c.html(layout('Chino Valley Today — Admin', body));
  });

  app.get('/posts/:slug/view', (c) => {
    const slug = c.req.param('slug');
    const post = getPost(db, slug);
    if (!post) return c.text('post not found', 404);
    const parsed = parsePostFile(readPostBody(post));
    const body = `
      <p><a href="/">&larr; back to dashboard</a></p>
      <h1>${esc(parsed.title || post.slug)}</h1>
      <p>${tierBadge(post.tier)} <span class="muted">${esc(post.post_type)} &middot; status: ${esc(post.status)}</span></p>
      ${renderMarkdown(parsed.body)}
    `;
    return c.html(layout(parsed.title || post.slug, body));
  });

  app.post('/posts/:slug/approve', async (c) => {
    const slug = c.req.param('slug');
    const post = getPost(db, slug);
    if (!post) return c.text('post not found', 404);
    if (post.status !== 'held') {
      return c.text(`post ${slug} is not in the held queue (status=${post.status})`, 400);
    }
    const form = await c.req.parseBody();
    // EDITORIAL.md Tier C rule, enforced server-side (not just the HTML
    // `required` attribute, which a raw form POST can bypass entirely).
    if (post.tier === 'C' && str(form.ack) !== '1') {
      return c.text(
        'Tier C approve rejected: required acknowledgment checkbox ("I have reviewed this item naming private individuals") was not checked.',
        400
      );
    }
    // transitionPost moves the file to content/published/ and updates the
    // posts row; write actions go through it exclusively so file and DB
    // status never drift apart. The non-null heldReason marker records that
    // this was a human approval (see renderAudit's sampling universe above).
    transitionPost(db, slug, 'published', {
      publishedVia: 'manual',
      heldReason: `reviewed:approved${post.tier === 'C' ? ' (Tier C acknowledgment confirmed)' : ''}`,
    });
    return c.redirect('/', 303);
  });

  app.post('/posts/:slug/reject', (c) => {
    const slug = c.req.param('slug');
    const post = getPost(db, slug);
    if (!post) return c.text('post not found', 404);
    if (post.status !== 'held') {
      return c.text(`post ${slug} is not in the held queue (status=${post.status})`, 400);
    }
    // No heldReason override here: the original held_reason (why it was
    // held) stays on the row as the historical record of the rejection.
    transitionPost(db, slug, 'rejected');
    return c.redirect('/', 303);
  });

  app.post('/audit/:slug', async (c) => {
    const slug = c.req.param('slug');
    const post = getPost(db, slug);
    if (!post) return c.text('post not found', 404);
    if (post.tier !== 'B' || post.status !== 'published' || post.held_reason != null) {
      return c.text(`post ${slug} is not eligible for audit (tier=${post.tier}, status=${post.status})`, 400);
    }
    const week = isoWeekString();
    if (!isSampledForAudit(slug, week)) {
      return c.text(`post ${slug} is not in this week's (${week}) audit sample`, 400);
    }
    const existing = db.raw
      .prepare(`SELECT id FROM audit_log WHERE post_id = ? AND iso_week = ?`)
      .get(post.id, week);
    if (existing) return c.text(`post ${slug} was already audited for ${week}`, 400);

    const form = await c.req.parseBody();
    const verdict = str(form.verdict);
    if (verdict !== 'pass' && verdict !== 'fail') return c.text('verdict must be pass or fail', 400);
    const notesRaw = str(form.notes).trim();
    db.raw
      .prepare(`INSERT INTO audit_log (post_id, iso_week, verdict, notes, audited_at) VALUES (?, ?, ?, ?, ?)`)
      .run(post.id, week, verdict, notesRaw || null, new Date().toISOString());
    return c.redirect('/', 303);
  });

  return app;
}
