-- Material entries: a material ("where the stuff for this thing lives") holds
-- 1..N entries. Each entry is one openable target: a local directory, a local
-- file, or a URL.
--
-- Why a child table instead of a JSON column on archive_items:
-- entries need their own sort_order so they can be ranked by how often they are
-- used (requirements 4.2 D2). A JSON blob cannot be sorted per entry.
--
-- Entries are pointers only. File bytes are never stored (requirements 4.1 M3).

CREATE TABLE archive_entries (
  id         TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES archive_items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('dir', 'file', 'url')),
  target     TEXT NOT NULL,
  note       TEXT,
  sort_order REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_archive_entries ON archive_entries(archive_id, sort_order)
  WHERE deleted_at IS NULL;

-- Migrate legacy data: anything that used to live in the single-value columns
-- becomes a first-class entry, so no information is lost when those columns are
-- dropped in migration 004.
--
-- Legacy shape: archive_items.url held a URL, archive_items.body held free text.
-- A URL becomes a 'url' entry. Free text becomes an entry ONLY when it contains
-- a path separator - i.e. only when it actually looks like a pointer. Prose is
-- deliberately left alone: it is not a pointer, and the user should decide what
-- to do with it (the orphan section of the material page lists such rows).
--
-- IDs are not RFC-4122 UUIDs here - they only need to be unique. Application
-- code always generates real UUIDs via crypto.randomUUID(); this is a one-off
-- backfill inside SQL. Collisions are effectively impossible given the random
-- hex suffix and the small number of legacy rows.

INSERT INTO archive_entries (id, archive_id, kind, target, sort_order, created_at, updated_at)
SELECT
  'legacy-url-' || lower(hex(randomblob(8))),
  id, 'url', TRIM(url), 1, created_at, updated_at
FROM archive_items
WHERE url IS NOT NULL AND TRIM(url) <> '';

INSERT INTO archive_entries (id, archive_id, kind, target, sort_order, created_at, updated_at)
SELECT
  'legacy-path-' || lower(hex(randomblob(8))),
  id,
  CASE WHEN body LIKE '%\%' OR body LIKE '%/%' THEN 'file' ELSE 'dir' END,
  TRIM(body), 1, created_at, updated_at
FROM archive_items
WHERE body IS NOT NULL AND TRIM(body) <> ''
  AND (body LIKE '%\%' OR body LIKE '%/%' OR body LIKE '_:%');
