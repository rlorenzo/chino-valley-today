import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from './index.ts';

// Item identity is (source, item_type, external_id), NOT (document_id, ...).
// `documents` is content-addressed, so a source re-uploading a changed document
// mints a new documents row; keying items on document_id would re-insert every
// item as a duplicate under the new id even though its source-native
// external_id never changed. bundle.ts's itemsFor() has no DISTINCT, so those
// duplicates would land in the same recap.

function freshDb(): Db {
  return openDb(':memory:');
}

function addSource(db: Db, key: string): number {
  return db.upsertSource({ key, name: key, base_url: `https://example.test/${key}`, method: 'html' });
}

// Each call simulates a fresh upload: a distinct content_hash under the same
// URL is exactly what a re-rendered packet PDF produces.
function addDocument(db: Db, sourceId: number, contentHash: string, url = 'https://example.test/packet.pdf'): number {
  return db.insertDocument({
    source_id: sourceId,
    url,
    doc_type: 'packet',
    title: 'Agenda packet',
    meeting_date: '2026-07-14',
    content_hash: contentHash,
    raw_path: `data/raw/${contentHash.slice(0, 2)}/${contentHash}.pdf`,
  }).id;
}

function countItems(db: Db): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM items').get() as unknown as { n: number }).n;
}

describe('item idempotency across document re-uploads', () => {
  test('a re-uploaded document updates the existing item instead of duplicating it', () => {
    const db = freshDb();
    const sourceId = addSource(db, 'chinohills-agendas');
    const doc1 = addDocument(db, sourceId, 'a'.repeat(64));

    const first = db.insertItem({
      document_id: doc1,
      source_url: 'https://example.test/packet.pdf#item-1',
      item_type: 'agenda_item',
      external_id: '2026-07-14-seq1155-1',
      title: 'Award of contract',
      body: 'original text',
    });
    assert.equal(first.isNew, true);

    // The packet is re-rendered: same URL, different bytes -> a new documents row.
    const doc2 = addDocument(db, sourceId, 'b'.repeat(64));
    assert.notEqual(doc2, doc1, 'a changed content_hash must create a distinct document');

    const second = db.insertItem({
      document_id: doc2,
      source_url: 'https://example.test/packet.pdf#item-1',
      item_type: 'agenda_item',
      external_id: '2026-07-14-seq1155-1',
      title: 'Award of contract',
      body: 'revised text',
    });

    assert.equal(second.isNew, false, 'the re-uploaded item must match the existing row');
    assert.equal(second.id, first.id, 'and must be the same row, not a new one');
    assert.equal(countItems(db), 1, 'the re-upload must not duplicate the item');

    const row = db.raw
      .prepare('SELECT document_id, body FROM items WHERE id = ?')
      .get(first.id) as unknown as { document_id: number; body: string };
    assert.equal(row.document_id, doc2, 'document_id must be repointed to the newest document');
    assert.equal(row.body, 'revised text', 'and the newest content must win');
  });

  test('repeated re-uploads keep collapsing onto one row', () => {
    const db = freshDb();
    const sourceId = addSource(db, 'chinohills-agendas');
    for (const hash of ['a', 'b', 'c', 'd']) {
      const doc = addDocument(db, sourceId, hash.repeat(64));
      db.insertItem({
        document_id: doc,
        source_url: 'https://example.test/packet.pdf#item-1',
        item_type: 'agenda_item',
        external_id: '2026-07-14-seq1155-1',
        title: 'Award of contract',
      });
    }
    assert.equal(countItems(db), 1, 'four uploads of the same item must leave one row');
  });

  test('the same external_id under a different item_type stays a separate item', () => {
    const db = freshDb();
    const sourceId = addSource(db, 'chino-legistar');
    const doc = addDocument(db, sourceId, 'a'.repeat(64));

    db.insertItem({
      document_id: doc,
      source_url: 'https://example.test/e#1',
      item_type: 'agenda_item',
      external_id: '53502',
    });
    db.insertItem({
      document_id: doc,
      source_url: 'https://example.test/e#1',
      item_type: 'vote',
      external_id: '53502',
    });
    assert.equal(countItems(db), 2, 'item_type is part of item identity');
  });

  test('two documents from ONE source with a colliding external_id stay separate', () => {
    // The reason identity is keyed on the document url and not on the source.
    // chino-agendacenter builds external_id as `<date>-<n>` per Agenda Center
    // category, and cvusd-board as `<date>-<n>` per meeting type — so two
    // commissions meeting on the same date, or a Regular plus a Special
    // meeting, produce the SAME external_id from the same source. Widening the
    // match to the source would silently merge them into one item.
    const db = freshDb();
    const sourceId = addSource(db, 'chino-agendacenter');
    const council = addDocument(db, sourceId, 'a'.repeat(64), 'https://example.test/council-2026-07-14.pdf');
    const planning = addDocument(db, sourceId, 'b'.repeat(64), 'https://example.test/planning-2026-07-14.pdf');

    const a = db.insertItem({
      document_id: council,
      source_url: 'https://example.test/council-2026-07-14.pdf#1',
      item_type: 'agenda_item',
      external_id: '2026-07-14-1',
      title: 'City Council item 1',
    });
    const b = db.insertItem({
      document_id: planning,
      source_url: 'https://example.test/planning-2026-07-14.pdf#1',
      item_type: 'agenda_item',
      external_id: '2026-07-14-1',
      title: 'Planning Commission item 1',
    });

    assert.equal(b.isNew, true, 'a different document must not match, even within one source');
    assert.notEqual(b.id, a.id);
    assert.equal(countItems(db), 2, 'two same-date meetings must not collapse into one item');
  });

  test('the same external_id from a different source stays a separate item', () => {
    // Matching on external_id alone would merge these: short source-native ids
    // (a bare sequence number, say) are only unique within their own source.
    const db = freshDb();
    const chino = addSource(db, 'chino-legistar');
    const hills = addSource(db, 'chinohills-agendas');
    const chinoDoc = addDocument(db, chino, 'a'.repeat(64), 'https://example.test/chino.pdf');
    const hillsDoc = addDocument(db, hills, 'b'.repeat(64), 'https://example.test/hills.pdf');

    const a = db.insertItem({
      document_id: chinoDoc,
      source_url: 'https://example.test/chino.pdf#1',
      item_type: 'agenda_item',
      external_id: '1',
      title: 'Chino item',
    });
    const b = db.insertItem({
      document_id: hillsDoc,
      source_url: 'https://example.test/hills.pdf#1',
      item_type: 'agenda_item',
      external_id: '1',
      title: 'Chino Hills item',
    });

    assert.equal(b.isNew, true, 'a different source must not match');
    assert.notEqual(b.id, a.id);
    assert.equal(countItems(db), 2);
  });

  test('a genuinely new item on a re-uploaded document is still inserted', () => {
    const db = freshDb();
    const sourceId = addSource(db, 'chinohills-agendas');
    const doc1 = addDocument(db, sourceId, 'a'.repeat(64));
    db.insertItem({
      document_id: doc1,
      source_url: 'https://example.test/packet.pdf#item-1',
      item_type: 'agenda_item',
      external_id: '2026-07-14-seq1155-1',
    });

    // The revised packet adds an item that wasn't in the original.
    const doc2 = addDocument(db, sourceId, 'b'.repeat(64));
    const added = db.insertItem({
      document_id: doc2,
      source_url: 'https://example.test/packet.pdf#item-2',
      item_type: 'agenda_item',
      external_id: '2026-07-14-seq1155-2',
    });
    assert.equal(added.isNew, true);
    assert.equal(countItems(db), 2, 'the added item must land alongside the carried-over one');
  });

  test('items without an external_id are not deduped (documented sharp edge)', () => {
    // external_id is nullable, and SQLite treats NULLs as distinct in UNIQUE.
    // insertItem skips the match entirely when it is null, so every re-run
    // inserts another row. Every current scraper sets one; this pins the
    // behavior so the gap is visible rather than surprising.
    const db = freshDb();
    const sourceId = addSource(db, 'chinohills-agendas');
    const doc = addDocument(db, sourceId, 'a'.repeat(64));
    for (let n = 0; n < 2; n++) {
      db.insertItem({
        document_id: doc,
        source_url: 'https://example.test/packet.pdf',
        item_type: 'agenda_item',
        external_id: null,
        title: 'untitled',
      });
    }
    assert.equal(countItems(db), 2);
  });

  test('the match-then-write leaves no transaction open', () => {
    // insertItem wraps its lookup and write in BEGIN IMMEDIATE so two writer
    // processes can't both miss the lookup and then both insert. Leaking that
    // transaction would hold the write lock for the rest of the process.
    const db = freshDb();
    const sourceId = addSource(db, 'chinohills-agendas');
    const doc = addDocument(db, sourceId, 'a'.repeat(64));
    assert.equal(db.raw.isTransaction, false, 'precondition: not in a transaction');

    db.insertItem({
      document_id: doc,
      source_url: 'https://example.test/packet.pdf#1',
      item_type: 'agenda_item',
      external_id: '2026-07-14-seq1155-1',
    });
    assert.equal(db.raw.isTransaction, false, 'the transaction must be committed, not left open');
  });

  test('an outer transaction is respected rather than nested', () => {
    // BEGIN inside a transaction is an error, so a caller batching many inserts
    // in one transaction must still work.
    const db = freshDb();
    const sourceId = addSource(db, 'chinohills-agendas');
    const doc = addDocument(db, sourceId, 'a'.repeat(64));

    db.raw.exec('BEGIN IMMEDIATE');
    for (let n = 1; n <= 3; n++) {
      db.insertItem({
        document_id: doc,
        source_url: `https://example.test/packet.pdf#${n}`,
        item_type: 'agenda_item',
        external_id: `2026-07-14-seq1155-${n}`,
      });
    }
    assert.equal(db.raw.isTransaction, true, 'the caller still owns its transaction');
    db.raw.exec('COMMIT');

    assert.equal(countItems(db), 3);
    assert.equal(db.raw.isTransaction, false);
  });

  test('the lookup index that serves this exists', () => {
    const db = freshDb();
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_items_external_id'")
      .get() as unknown as { name: string } | undefined;
    assert.ok(idx, 'idx_items_external_id must exist — the UNIQUE autoindex leads with document_id');
  });
});
