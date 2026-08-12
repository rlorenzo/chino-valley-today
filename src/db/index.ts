import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
export const DB_PATH = process.env.CVT_DB ?? join(ROOT, 'data', 'cvtoday.db');

export interface SourceRow {
  id: number;
  key: string;
  name: string;
  base_url: string;
  method: string;
  active: number;
}

export interface DocumentRow {
  id: number;
  source_id: number;
  url: string;
  doc_type: string;
  title: string | null;
  meeting_date: string | null;
  fetched_at: string;
  content_hash: string;
  raw_path: string;
  etag: string | null;
  last_modified: string | null;
}

export interface NewDocument {
  source_id: number;
  url: string;
  doc_type: string;
  title?: string | null;
  meeting_date?: string | null;
  content_hash: string;
  raw_path: string;
  etag?: string | null;
  last_modified?: string | null;
  location?: string | null;
  event_key?: string | null;
}

export interface NewItem {
  document_id: number;
  source_url: string;
  item_type: string;
  external_id?: string | null;
  title?: string | null;
  body?: string | null;
  meta?: unknown;
  occurred_at?: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function openDb(path: string = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  // Additive migrations for DBs created before these columns existed
  // (recommended by the city-scrapers schema comparison; see SOURCES.md).
  const docCols = (db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!docCols.includes('location')) db.exec('ALTER TABLE documents ADD COLUMN location TEXT');
  if (!docCols.includes('event_key')) db.exec('ALTER TABLE documents ADD COLUMN event_key TEXT');

  function upsertSource(s: { key: string; name: string; base_url: string; method: string }): number {
    db.prepare(
      `INSERT INTO sources (key, name, base_url, method) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, method = excluded.method`
    ).run(s.key, s.name, s.base_url, s.method);
    const row = db.prepare('SELECT id FROM sources WHERE key = ?').get(s.key) as unknown as { id: number };
    return row.id;
  }

  function latestDocument(url: string): DocumentRow | undefined {
    return db.prepare('SELECT * FROM documents WHERE url = ? ORDER BY id DESC LIMIT 1').get(url) as
      | DocumentRow
      | undefined;
  }

  function touchDocument(id: number): void {
    db.prepare('UPDATE documents SET fetched_at = ? WHERE id = ?').run(nowIso(), id);
  }

  function insertDocument(d: NewDocument): { id: number; isNew: boolean } {
    const existing = db
      .prepare('SELECT id FROM documents WHERE url = ? AND content_hash = ?')
      .get(d.url, d.content_hash) as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE documents SET fetched_at = ?, etag = ?, last_modified = ? WHERE id = ?').run(
        nowIso(),
        d.etag ?? null,
        d.last_modified ?? null,
        existing.id
      );
      return { id: existing.id, isNew: false };
    }
    const res = db
      .prepare(
        `INSERT INTO documents (source_id, url, doc_type, title, meeting_date, fetched_at, content_hash, raw_path, etag, last_modified, location, event_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.source_id,
        d.url,
        d.doc_type,
        d.title ?? null,
        d.meeting_date ?? null,
        nowIso(),
        d.content_hash,
        d.raw_path,
        d.etag ?? null,
        d.last_modified ?? null,
        d.location ?? null,
        d.event_key ?? null
      );
    return { id: Number(res.lastInsertRowid), isNew: true };
  }

  // Idempotent when external_id is provided (re-runs update in place). Always
  // provide a stable external_id; derive one (e.g. a hash of title+date) when
  // the source has no native ID, or re-runs will duplicate rows.
  function insertItem(i: NewItem): { id: number; isNew: boolean } {
    if (!i.source_url) {
      throw new Error(`item missing source_url (item_type=${i.item_type}, title=${i.title ?? ''})`);
    }
    const meta = i.meta === undefined || i.meta === null ? null : JSON.stringify(i.meta);
    if (i.external_id != null) {
      const existing = db
        .prepare('SELECT id FROM items WHERE document_id = ? AND external_id = ? AND item_type = ?')
        .get(i.document_id, i.external_id, i.item_type) as unknown as { id: number } | undefined;
      if (existing) {
        db.prepare('UPDATE items SET source_url = ?, title = ?, body = ?, meta = ?, occurred_at = ? WHERE id = ?').run(
          i.source_url,
          i.title ?? null,
          i.body ?? null,
          meta,
          i.occurred_at ?? null,
          existing.id
        );
        return { id: existing.id, isNew: false };
      }
    }
    const res = db
      .prepare(
        `INSERT INTO items (document_id, source_url, item_type, external_id, title, body, meta, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        i.document_id,
        i.source_url,
        i.item_type,
        i.external_id ?? null,
        i.title ?? null,
        i.body ?? null,
        meta,
        i.occurred_at ?? null
      );
    return { id: Number(res.lastInsertRowid), isNew: true };
  }

  return { raw: db, path, upsertSource, latestDocument, touchDocument, insertDocument, insertItem };
}

export type Db = ReturnType<typeof openDb>;
