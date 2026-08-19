import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
// ROOT is defined once, in store.ts. Re-deriving it here produced two exports
// with the same name and different relative depths.
import { SOURCE_TOS_REGISTRY } from "../gates/tos-config.ts";
import { ROOT } from "../store.ts";

// Still needed for schema.sql, which sits beside this file rather than at ROOT.
const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CVT_DB ?? join(ROOT, "data", "cvtoday.db");

export interface SourceTosStatus {
	status: "enabled" | "held";
	heldReason?: string | null;
	reviewedHash: string;
	lastObservedHash?: string | null;
	lastCheckedAt?: string | null;
}

interface DocumentRow {
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

interface NewDocument {
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
	// Required: item identity is (document url, item_type, external_id). SQLite
	// treats NULLs as distinct in UNIQUE, and a null here would skip the identity
	// lookup entirely, so an item without one duplicates on every single run.
	external_id: string;
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
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA busy_timeout = 10000;");
	db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
	// Additive migrations for DBs created before these columns existed
	// (recommended by the city-scrapers schema comparison; see SOURCES.md).
	const docCols = (
		db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>
	).map((c) => c.name);
	if (!docCols.includes("location"))
		db.exec("ALTER TABLE documents ADD COLUMN location TEXT");
	if (!docCols.includes("event_key"))
		db.exec("ALTER TABLE documents ADD COLUMN event_key TEXT");
	const postCols = (
		db.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>
	).map((c) => c.name);
	if (!postCols.includes("published_via"))
		db.exec("ALTER TABLE posts ADD COLUMN published_via TEXT");

	// Seed the ToS baseline for every registered secondary source, so the gate
	// has a row to read on the very first run — before the scraper itself has
	// ever run. OR IGNORE keeps an operator's later hold/reset in place: the
	// registry is the baseline, not the truth.
	for (const [key, cfg] of Object.entries(SOURCE_TOS_REGISTRY)) {
		// source_tos_status.source_key REFERENCES sources(key), and node:sqlite
		// enforces foreign keys, so the parent row has to exist first. These are
		// placeholders; the scraper's own upsertSource replaces them with the real
		// display name and site root the first time it runs.
		db.prepare(
			`INSERT OR IGNORE INTO sources (key, name, base_url, method) VALUES (?, ?, ?, ?)`,
		).run(key, key, new URL(cfg.terms_url).origin, "html");
		db.prepare(
			`INSERT OR IGNORE INTO source_tos_status (source_key, status, reviewed_hash, held_reason)
			 VALUES (?, ?, ?, ?)`,
		).run(
			key,
			cfg.status,
			cfg.reviewed_hash,
			cfg.status === "held" ? "baseline_held" : null,
		);
	}

	function upsertSource(s: {
		key: string;
		name: string;
		base_url: string;
		method: string;
	}): number {
		db.prepare(
			`INSERT INTO sources (key, name, base_url, method) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, method = excluded.method`,
		).run(s.key, s.name, s.base_url, s.method);
		const row = db
			.prepare("SELECT id FROM sources WHERE key = ?")
			.get(s.key) as unknown as { id: number };
		return row.id;
	}

	function latestDocument(url: string): DocumentRow | undefined {
		return db
			.prepare("SELECT * FROM documents WHERE url = ? ORDER BY id DESC LIMIT 1")
			.get(url) as DocumentRow | undefined;
	}

	function touchDocument(id: number): void {
		db.prepare("UPDATE documents SET fetched_at = ? WHERE id = ?").run(
			nowIso(),
			id,
		);
	}

	function insertDocument(d: NewDocument): { id: number; isNew: boolean } {
		const existing = db
			.prepare("SELECT id FROM documents WHERE url = ? AND content_hash = ?")
			.get(d.url, d.content_hash) as unknown as { id: number } | undefined;
		if (existing) {
			db.prepare(
				"UPDATE documents SET fetched_at = ?, etag = ?, last_modified = ? WHERE id = ?",
			).run(nowIso(), d.etag ?? null, d.last_modified ?? null, existing.id);
			return { id: existing.id, isNew: false };
		}
		const res = db
			.prepare(
				`INSERT INTO documents (source_id, url, doc_type, title, meeting_date, fetched_at, content_hash, raw_path, etag, last_modified, location, event_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				d.event_key ?? null,
			);
		return { id: Number(res.lastInsertRowid), isNew: true };
	}

	// Idempotent when external_id is provided (re-runs update in place). Always
	// provide a stable external_id; derive one (e.g. a hash of title+date) when
	// the source has no native ID, or re-runs will duplicate rows.
	//
	// Identity is (document URL, item_type, external_id) — scoped to the URL
	// rather than to document_id, even though the table's UNIQUE constraint uses
	// document_id. `documents` is content-addressed (UNIQUE(url, content_hash)),
	// so a source re-uploading a changed document — AgendaQuick re-rendering a
	// packet PDF, say — mints a new documents row at the SAME url, and a
	// document-scoped lookup would re-insert every item as a duplicate under the
	// new document_id despite an unchanged source-native external_id. Nothing
	// downstream dedupes: bundle.ts's itemsFor() selects by (source, item_type,
	// date) with no DISTINCT, so both copies would land in the same recap.
	//
	// Keying on the url is what makes this safe. A re-upload is by definition the
	// same url with new bytes, so it matches; two genuinely different documents
	// have different urls, so they never merge. Widening to the whole source
	// would be wrong: chino-agendacenter builds external_id as `<date>-<n>` per
	// Agenda Center CATEGORY and cvusd-board as `<date>-<n>` per meeting type, so
	// two commissions (or a Regular and a Special meeting) sharing a date collide
	// on external_id and would be silently merged into one item.
	//
	// This narrows what a row means: items holds the CURRENT version of each item,
	// not every version. Prior versions remain recoverable from the raw archive
	// and the superseded documents row, which is where the byte-level history is
	// meant to live.
	// The match-then-write below has to be atomic. Each entry point (npm run
	// poc/one/tiera/recap/tracker) is its own process, so a hand-run scrape
	// overlapping a scheduled one — routine once Phase 2's systemd timers land —
	// puts two writers on this DB. Both would miss the lookup, then both insert
	// under different document_ids, which the retained
	// UNIQUE(document_id, external_id, item_type) accepts happily, reintroducing
	// exactly the duplicate this function exists to prevent. BEGIN IMMEDIATE takes
	// the write lock up front, so the second writer blocks on busy_timeout (10s)
	// and its lookup then sees the first's committed row. This costs nothing
	// extra: every insert here was already its own implicit transaction.
	function insertItemAtomic(
		i: NewItem,
		meta: string | null,
	): { id: number; isNew: boolean } {
		{
			// Oldest row wins the match, so repeated re-uploads keep collapsing onto
			// one row instead of fanning out.
			const existing = db
				.prepare(
					`SELECT i.id FROM items i
             JOIN documents d ON d.id = i.document_id
            WHERE d.url = (SELECT url FROM documents WHERE id = ?)
              AND i.external_id = ?
              AND i.item_type = ?
            ORDER BY i.id
            LIMIT 1`,
				)
				.get(i.document_id, i.external_id, i.item_type) as unknown as
				| { id: number }
				| undefined;
			if (existing) {
				db.prepare(
					"UPDATE items SET document_id = ?, source_url = ?, title = ?, body = ?, meta = ?, occurred_at = ? WHERE id = ?",
				).run(
					i.document_id,
					i.source_url,
					i.title ?? null,
					i.body ?? null,
					meta,
					i.occurred_at ?? null,
					existing.id,
				);
				return { id: existing.id, isNew: false };
			}
		}
		const res = db
			.prepare(
				`INSERT INTO items (document_id, source_url, item_type, external_id, title, body, meta, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				i.document_id,
				i.source_url,
				i.item_type,
				i.external_id ?? null,
				i.title ?? null,
				i.body ?? null,
				meta,
				i.occurred_at ?? null,
			);
		return { id: Number(res.lastInsertRowid), isNew: true };
	}

	function insertItem(i: NewItem): { id: number; isNew: boolean } {
		if (!i.source_url) {
			throw new Error(
				`item missing source_url (item_type=${i.item_type}, title=${i.title ?? ""})`,
			);
		}
		// Fail loudly rather than silently duplicating on every run. The type makes
		// this unreachable from TypeScript callers; the check catches JS callers and
		// values that are empty at runtime.
		if (!i.external_id) {
			throw new Error(
				`item missing external_id (item_type=${i.item_type}, title=${i.title ?? ""})`,
			);
		}
		const meta =
			i.meta === undefined || i.meta === null ? null : JSON.stringify(i.meta);
		// Respect an outer transaction if a caller ever opens one to batch inserts;
		// BEGIN inside a transaction is an error.
		if (db.isTransaction) return insertItemAtomic(i, meta);
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = insertItemAtomic(i, meta);
			db.exec("COMMIT");
			return result;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	function startScrapeRun(sourceKey: string): number {
		const res = db
			.prepare(
				"INSERT INTO scrape_runs (source_key, started_at, status) VALUES (?, ?, 'running')",
			)
			.run(sourceKey, nowIso());
		return Number(res.lastInsertRowid);
	}

	function finishScrapeRun(
		id: number,
		opts: {
			status: "success" | "failure";
			errorMessage?: string | null;
			documentsCount?: number;
			itemsCount?: number;
		},
	): void {
		db.prepare(
			`UPDATE scrape_runs
       SET finished_at = ?, status = ?, error_message = ?, documents_count = ?, items_count = ?
       WHERE id = ?`,
		).run(
			nowIso(),
			opts.status,
			opts.errorMessage ?? null,
			opts.documentsCount ?? 0,
			opts.itemsCount ?? 0,
			id,
		);
	}

	// Fails closed: anything unreviewed reads back as held, never as enabled.
	// That covers both a source_key absent from the baseline registry and one
	// that's registered but has no row yet (shouldn't happen post-openDb, since
	// openDb seeds a row for every SOURCE_TOS_REGISTRY entry, but a missing row
	// must never be misread as "safe to scrape").
	//
	// Civic/agency sources were never meant to go through this gate at all —
	// they carry no publisher ToS to track. Callers must only ask about sources
	// with tracked terms (run-one.ts checks `sourceKey in SOURCE_TOS_REGISTRY`
	// before calling this at all); asking about anything else now returns held,
	// not a silent "enabled" pass-through.
	function getSourceTosStatus(sourceKey: string): SourceTosStatus {
		const unreviewed: SourceTosStatus = {
			status: "held",
			heldReason: "unreviewed_source",
			reviewedHash: "",
		};
		// Object.hasOwn, not `in`: `in` walks the prototype chain, so a key
		// like "constructor" would read as registered.
		if (!Object.hasOwn(SOURCE_TOS_REGISTRY, sourceKey)) return unreviewed;

		const row = db
			.prepare(
				"SELECT status, reviewed_hash, last_observed_hash, last_checked_at, held_reason FROM source_tos_status WHERE source_key = ?",
			)
			.get(sourceKey) as
			| {
					status: SourceTosStatus["status"];
					reviewed_hash: string;
					last_observed_hash: string | null;
					last_checked_at: string | null;
					held_reason: string | null;
			  }
			| undefined;

		if (!row) return unreviewed;

		return {
			status: row.status,
			heldReason: row.held_reason,
			reviewedHash: row.reviewed_hash,
			lastObservedHash: row.last_observed_hash,
			lastCheckedAt: row.last_checked_at,
		};
	}

	function setSourceTosHold(
		sourceKey: string,
		opts: {
			reason: string;
			observedHash?: string | null;
			checkedAt?: string;
		},
	): void {
		const registryConfig = SOURCE_TOS_REGISTRY[sourceKey];
		const reviewedHash = registryConfig?.reviewed_hash ?? "";
		const checkedAt = opts.checkedAt ?? nowIso();
		db.prepare(
			`INSERT INTO source_tos_status (source_key, status, reviewed_hash, last_observed_hash, last_checked_at, held_reason)
			 VALUES (?, 'held', ?, ?, ?, ?)
			 ON CONFLICT(source_key) DO UPDATE SET
			   status = 'held',
			   held_reason = excluded.held_reason,
			   last_observed_hash = COALESCE(excluded.last_observed_hash, source_tos_status.last_observed_hash),
			   last_checked_at = excluded.last_checked_at`,
		).run(
			sourceKey,
			reviewedHash,
			opts.observedHash ?? null,
			checkedAt,
			opts.reason,
		);
	}

	function recordSourceTosCheck(
		sourceKey: string,
		opts: {
			observedHash: string;
			checkedAt: string;
		},
	): void {
		const current = getSourceTosStatus(sourceKey);
		if (opts.observedHash !== current.reviewedHash) {
			setSourceTosHold(sourceKey, {
				reason: "terms_hash_drift",
				observedHash: opts.observedHash,
				checkedAt: opts.checkedAt,
			});
			return;
		}
		// A matching hash records the observation but never clears an existing
		// hold. Coming back online is an operator decision (resetSourceTosHold),
		// because the hold may rest on something this check cannot see.
		db.prepare(
			`UPDATE source_tos_status
			 SET last_observed_hash = ?, last_checked_at = ?
			 WHERE source_key = ?`,
		).run(opts.observedHash, opts.checkedAt, sourceKey);
	}

	function resetSourceTosHold(
		sourceKey: string,
		opts: {
			observedHash: string;
			checkedAt: string;
		},
	): void {
		const registryConfig = SOURCE_TOS_REGISTRY[sourceKey];
		if (registryConfig?.status !== "enabled") {
			throw new Error(
				`Cannot reset ToS hold: source ${sourceKey} is configured as 'held' in baseline registry. Update baseline contract first.`,
			);
		}
		if (opts.observedHash !== registryConfig.reviewed_hash) {
			throw new Error(
				`Cannot reset ToS hold: observed hash (${opts.observedHash}) does not match baseline reviewed hash (${registryConfig.reviewed_hash})`,
			);
		}
		db.prepare(
			`INSERT INTO source_tos_status (source_key, status, reviewed_hash, last_observed_hash, last_checked_at, held_reason)
			 VALUES (?, 'enabled', ?, ?, ?, NULL)
			 ON CONFLICT(source_key) DO UPDATE SET
			   status = 'enabled',
			   -- The reset is what re-baselines the row against the registry: the
			   -- operator reviewed the new terms and updated tos-config. Leaving
			   -- the stale hash here would make the next weekly check read its own
			   -- approved hash as drift and re-hold the source immediately.
			   reviewed_hash = excluded.reviewed_hash,
			   held_reason = NULL,
			   last_observed_hash = excluded.last_observed_hash,
			   last_checked_at = excluded.last_checked_at`,
		).run(
			sourceKey,
			registryConfig.reviewed_hash,
			opts.observedHash,
			opts.checkedAt,
		);
	}

	return {
		raw: db,
		path,
		upsertSource,
		latestDocument,
		touchDocument,
		insertDocument,
		insertItem,
		startScrapeRun,
		finishScrapeRun,
		getSourceTosStatus,
		setSourceTosHold,
		recordSourceTosCheck,
		resetSourceTosHold,
	};
}

export type Db = ReturnType<typeof openDb>;
