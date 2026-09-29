-- Replace the table-level UNIQUE on daily_logs.day_key with a partial unique
-- index that only covers living rows.
--
-- Why: a table-level UNIQUE also reserves the key for soft-deleted rows, so
-- deleting a day's log and writing it again failed with "UNIQUE constraint
-- failed: daily_logs.day_key". The real rule is "at most one LIVE log per day".
-- SQLite cannot drop a table-level UNIQUE in place, so the table is rebuilt.
--
-- Note: SQLite cannot run ALTER TABLE on search_fts here, and nothing else
-- references daily_logs, so the rebuild is self-contained.

CREATE TABLE daily_logs_new (
  id         TEXT PRIMARY KEY,
  day_key    TEXT NOT NULL,
  body       TEXT,
  mood       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO daily_logs_new (id, day_key, body, mood, created_at, updated_at, deleted_at)
SELECT id, day_key, body, mood, created_at, updated_at, deleted_at FROM daily_logs;

DROP TABLE daily_logs;

ALTER TABLE daily_logs_new RENAME TO daily_logs;

-- One live log per day; soft-deleted rows no longer reserve their day_key.
CREATE UNIQUE INDEX idx_daily_logs_day ON daily_logs(day_key) WHERE deleted_at IS NULL;
