// Post lifecycle: content lives as markdown+frontmatter in content/<status>/,
// state lives in the posts table. Auto and manual paths share these functions.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowIso, type Db } from '../db/index.ts';
import { ROOT } from '../store.ts';

export type PostStatus = 'queued' | 'held' | 'published' | 'rejected';
export type Tier = 'A' | 'B' | 'C';

export interface PostRow {
  id: number;
  slug: string;
  post_type: string;
  tier: Tier;
  status: PostStatus;
  file_path: string;
  meeting_date: string | null;
  gates: string | null;
  judge: string | null;
  source_count: number | null;
  held_reason: string | null;
  published_via: 'auto' | 'manual' | null;
  created_at: string;
  published_at: string | null;
}

export interface NewPost {
  slug: string; // stable across re-runs; re-running a generator updates in place
  postType: 'meeting_preview' | 'meeting_recap' | 'business_tracker' | 'alert' | 'news_digest';
  tier: Tier;
  title: string;
  bodyMd: string; // markdown body; the disclosure footer is appended automatically
  meetingDate?: string;
  sources: string[]; // source_urls backing every claim in the post
}

const DIR_BY_STATUS: Record<PostStatus, string> = {
  queued: join('content', 'queue'),
  held: join('content', 'held'),
  published: join('content', 'published'),
  rejected: join('content', 'rejected'),
};

export const DISCLOSURE_FOOTER =
  '\n\n---\n\n*Generated from public records with automated review; see sources linked above. Corrections: see About page.*\n';

// JSON string literals are valid YAML scalars — safe without a YAML dep.
function y(s: string): string {
  return JSON.stringify(s);
}

export function renderPostFile(p: NewPost, createdAt: string): string {
  const fm = [
    '---',
    `title: ${y(p.title)}`,
    `post_type: ${p.postType}`,
    `tier: ${p.tier}`,
    `date: ${y(createdAt)}`,
    ...(p.meetingDate ? [`meeting_date: ${y(p.meetingDate)}`] : []),
    'sources:',
    ...p.sources.map((s) => `  - ${y(s)}`),
    '---',
  ].join('\n');
  return `${fm}\n\n${p.bodyMd.trim()}${DISCLOSURE_FOOTER}`;
}

function writePostFile(relPath: string, content: string): void {
  const abs = join(ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function getPost(db: Db, slug: string): PostRow | undefined {
  return db.raw.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
}

export function listPosts(db: Db, status?: PostStatus): PostRow[] {
  return (
    status
      ? db.raw.prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.raw.prepare('SELECT * FROM posts ORDER BY created_at DESC').all()
  ) as unknown as PostRow[];
}

// Idempotent create: same slug re-queued updates content in place; posts a
// human already published or rejected are never clobbered by a generator.
export function createPost(
  db: Db,
  p: NewPost
): { id: number; filePath: string; outcome: 'created' | 'updated' | 'skipped' } {
  if (p.sources.length === 0) throw new Error(`post ${p.slug}: sources[] must not be empty`);
  const existing = getPost(db, p.slug);
  if (existing) {
    if (existing.status === 'published' || existing.status === 'rejected') {
      return { id: existing.id, filePath: existing.file_path, outcome: 'skipped' };
    }
    writePostFile(existing.file_path, renderPostFile(p, existing.created_at));
    db.raw
      .prepare('UPDATE posts SET post_type = ?, tier = ?, meeting_date = ?, source_count = ? WHERE id = ?')
      .run(p.postType, p.tier, p.meetingDate ?? null, p.sources.length, existing.id);
    return { id: existing.id, filePath: existing.file_path, outcome: 'updated' };
  }
  const createdAt = nowIso();
  const filePath = join(DIR_BY_STATUS.queued, `${p.slug}.md`);
  writePostFile(filePath, renderPostFile(p, createdAt));
  const res = db.raw
    .prepare(
      `INSERT INTO posts (slug, post_type, tier, status, file_path, meeting_date, source_count, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
    )
    .run(p.slug, p.postType, p.tier, filePath, p.meetingDate ?? null, p.sources.length, createdAt);
  return { id: Number(res.lastInsertRowid), filePath, outcome: 'created' };
}

export function transitionPost(
  db: Db,
  slug: string,
  to: PostStatus,
  opts: { heldReason?: string; gates?: unknown; judge?: unknown; publishedVia?: 'auto' | 'manual' } = {}
): PostRow {
  const row = getPost(db, slug);
  if (!row) throw new Error(`no post with slug ${slug}`);
  const newPath = join(DIR_BY_STATUS[to], `${row.slug}.md`);
  if (newPath !== row.file_path) {
    const absNew = join(ROOT, newPath);
    mkdirSync(dirname(absNew), { recursive: true });
    if (existsSync(join(ROOT, row.file_path))) renameSync(join(ROOT, row.file_path), absNew);
  }
  db.raw
    .prepare(
      `UPDATE posts SET status = ?, file_path = ?, held_reason = ?, gates = COALESCE(?, gates),
       judge = COALESCE(?, judge),
       published_via = CASE WHEN ? = 'published' THEN ? ELSE published_via END,
       published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END
       WHERE id = ?`
    )
    .run(
      to,
      newPath,
      opts.heldReason ?? null,
      opts.gates !== undefined ? JSON.stringify(opts.gates) : null,
      opts.judge !== undefined ? JSON.stringify(opts.judge) : null,
      to,
      opts.publishedVia ?? 'auto', // pipeline calls are the auto path; the dashboard passes 'manual'
      to,
      nowIso(),
      row.id
    );
  return getPost(db, slug)!;
}
