CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,          -- 'chino-legistar', 'cvusd-board', ...
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  method TEXT NOT NULL,              -- 'api' | 'rss' | 'html' | 'pdf' | 'captions'
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  url TEXT NOT NULL,                 -- canonical public URL (the link-back target)
  doc_type TEXT NOT NULL,            -- 'agenda','minutes','packet','video','captions',
                                     -- 'news_release','alert','license_report'
  title TEXT,
  meeting_date TEXT,                 -- ISO date if applicable
  fetched_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,        -- sha256 of raw bytes
  raw_path TEXT NOT NULL,            -- data/raw/... location
  etag TEXT, last_modified TEXT,
  location TEXT,                     -- meeting location, when the source provides one
  event_key TEXT,                    -- source-native event identity (Legistar EventId etc.)
                                     -- ties sibling documents (agenda/minutes/video) together
  UNIQUE(url, content_hash)
);

-- Phase 1: pipeline state. Post CONTENT lives in content/<status>/<slug>.md
-- (markdown + frontmatter, Astro-ready); these tables hold state + audit.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  post_type TEXT NOT NULL,           -- 'meeting_preview','meeting_recap','business_tracker',
                                     -- 'business_narrative','alert','news_digest','daily-brief'
  tier TEXT NOT NULL CHECK (tier IN ('A','B','C')),
  status TEXT NOT NULL DEFAULT 'queued',  -- 'queued','held','published','rejected'
  file_path TEXT NOT NULL,           -- content/... location (moves with status)
  meeting_date TEXT,
  gates JSON,                        -- Gate 1 validator results
  judge JSON,                        -- Gate 2 structured verdict
  source_count INTEGER,
  held_reason TEXT,
  published_via TEXT,                -- 'auto' | 'manual' (set on publish)
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  iso_week TEXT NOT NULL,            -- sample seed week, e.g. '2026-W33'
  verdict TEXT NOT NULL,             -- 'pass','fail'
  notes TEXT,
  audited_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  source_url TEXT NOT NULL CHECK (length(source_url) > 0),  -- provenance, enforced
  item_type TEXT NOT NULL,           -- 'agenda_item','vote','news_release','alert',
                                     -- 'license_event','transcript_segment'
  external_id TEXT,                  -- Legistar EventItemId, ABC license number, etc.
  title TEXT,
  body TEXT,                         -- extracted text
  meta JSON,                         -- votes, timestamps, addresses, license type...
  occurred_at TEXT,
  UNIQUE(document_id, external_id, item_type)
);

-- insertItem() resolves item identity as (document url, item_type, external_id)
-- so a re-uploaded document doesn't duplicate its items (see the comment there).
-- The UNIQUE constraint above leads with document_id, so its autoindex can't
-- serve that lookup; this one can.
CREATE INDEX IF NOT EXISTS idx_items_external_id ON items(external_id, item_type);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES sources(key),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failure')),
  error_message TEXT,
  documents_count INTEGER DEFAULT 0,
  items_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_source_id ON scrape_runs(source_key, id DESC);

CREATE TABLE IF NOT EXISTS source_tos_status (
  source_key TEXT PRIMARY KEY REFERENCES sources(key),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'held')),
  -- What the weekly check compares against: the last version cleared, whether
  -- by a full re-baseline or by an attestation.
  reviewed_hash TEXT NOT NULL,
  last_observed_hash TEXT,
  last_checked_at TEXT,
  held_reason TEXT,
  -- The last version a human read IN FULL. Drift is classified against this,
  -- never against last week: a redesign that migrates a clause into a widget
  -- over several deploys passes every week-on-week step and fails this one.
  anchor_hash TEXT,
  -- Consecutive attestations since that full read, and when it happened.
  -- Together they enforce the attestation lease, whose limits are set in
  -- tos-config.ts (MAX_CONSECUTIVE_ATTESTATIONS and ATTEST_LEASE_DAYS).
  attest_count INTEGER NOT NULL DEFAULT 0,
  last_rebaselined_at TEXT
);

-- Every clearance of a ToS hold, and what it rested on. Separate from
-- audit_log, which is post-scoped (audit_log.post_id is NOT NULL).
CREATE TABLE IF NOT EXISTS tos_attestations (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES sources(key),
  kind TEXT NOT NULL CHECK (kind IN ('attest', 'rebaseline')),
  from_hash TEXT,
  to_hash TEXT NOT NULL,
  anchor_hash TEXT,
  evidence TEXT NOT NULL,
  attested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tos_attestations_source
  ON tos_attestations(source_key, id DESC);

