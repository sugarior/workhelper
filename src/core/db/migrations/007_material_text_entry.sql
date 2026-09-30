-- Add the 'text' material entry kind.
--
-- Why: M3 says "pointers and notes only, never file bytes" — it forbids storing
-- file CONTENT in the database (which would drag in storage, dedup, backup and
-- cleanup work), NOT text. A line like "paper original is in the left drawer"
-- IS pointer information: it points at a physical thing. It simply is not one of
-- dir/file/url.
--
-- Dropping such lines (the previous behavior: they went to `leftovers` and were
-- discarded at "存为资料") directly contradicted the "never lose content" rule.
-- The user's real scenario (S5: task "reimburse" → materials show both the
-- template file and where the paper original lives) requires this.
--
-- Fourth kind alongside dir / file / url. Consequence, accepted deliberately:
-- a text entry cannot be "opened" — the UI skips it when opening and offers
-- copy instead, and labels it as text so that is not surprising.
--
-- Needs a table rebuild because SQLite cannot alter a CHECK constraint.
-- Same approach as migrations 002 and 006.
--
-- IMPORTANT: the column list, defaults, the CHECK and the FOREIGN KEY below must
-- stay byte-for-byte compatible with 003_material_entries.sql (only the `kind`
-- CHECK gains 'text'). A rebuild that quietly drops a constraint is worse than
-- no rebuild at all — the same mistake was avoided in 006 by copying 001 verbatim.

DROP INDEX IF EXISTS idx_archive_entries;

ALTER TABLE archive_entries RENAME TO archive_entries_old;

CREATE TABLE archive_entries (
  id         TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES archive_items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('dir', 'file', 'url', 'text')),
  target     TEXT NOT NULL,
  note       TEXT,
  sort_order REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO archive_entries
  (id, archive_id, kind, target, note, sort_order, created_at, updated_at, deleted_at)
SELECT
  id, archive_id, kind, target, note, sort_order, created_at, updated_at, deleted_at
FROM archive_entries_old;

DROP TABLE archive_entries_old;

CREATE INDEX idx_archive_entries ON archive_entries(archive_id, sort_order)
  WHERE deleted_at IS NULL;
