-- Initial schema: tables, indexes, full-text search table.
-- Table order matters: inbox_items must exist before tasks references it.
-- Keep this file in sync with docs/design.md section 4.4.
--
-- NOTE: all SQL files must stay pure ASCII. SQLite's exec() starts parsing at
-- byte 0, and a non-ASCII comment (e.g. a full-width bracket) makes it fail
-- with a confusing 'near "/": syntax error'. Chinese explanation lives in the
-- design doc; keep comments here ASCII-only.

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  goal       TEXT,
  status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused','done','archived')),
  priority   TEXT NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('high','normal','low')),
  start_date TEXT,
  due_date   TEXT,
  sort_order REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_projects_status ON projects(status, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE inbox_items (
  id           TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  kind_hint    TEXT CHECK (kind_hint IN ('todo','note')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','converted','archived')),
  parsed_due   TEXT,
  raw_input    TEXT,
  converted_to TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_inbox_pending ON inbox_items(created_at DESC)
  WHERE status = 'pending' AND deleted_at IS NULL;

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  detail           TEXT,
  status           TEXT NOT NULL DEFAULT 'todo'
                     CHECK (status IN ('todo','doing','blocked','done','cancelled')),
  priority         TEXT NOT NULL DEFAULT 'normal'
                     CHECK (priority IN ('high','normal','low')),
  due_at           TEXT,
  due_date         TEXT,
  estimate_minutes INTEGER,
  blocked_reason   TEXT,
  planned_for      TEXT,
  completed_at     TEXT,
  sort_order       REAL NOT NULL DEFAULT 1,
  source_inbox_id  TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_tasks_project ON tasks(project_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_status  ON tasks(status, due_date)       WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_today   ON tasks(planned_for)            WHERE deleted_at IS NULL;

CREATE TABLE subtasks (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
  due_date     TEXT,
  completed_at TEXT,
  sort_order   REAL NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_subtasks_task ON subtasks(task_id, sort_order) WHERE deleted_at IS NULL;

-- progress_entries attaches to exactly one of project / task / subtask (CHECK).
CREATE TABLE progress_entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id)    ON DELETE CASCADE,
  subtask_id  TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'progress'
                CHECK (kind IN ('progress','blocker','decision','waiting')),
  body        TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  CHECK ((project_id IS NOT NULL) + (task_id IS NOT NULL) + (subtask_id IS NOT NULL) = 1)
);
CREATE INDEX idx_progress_task    ON progress_entries(task_id, occurred_at DESC)    WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_project ON progress_entries(project_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_subtask ON progress_entries(subtask_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_day     ON progress_entries(day_key)                      WHERE deleted_at IS NULL;

CREATE TABLE daily_logs (
  id         TEXT PRIMARY KEY,
  day_key    TEXT NOT NULL UNIQUE,
  body       TEXT,
  mood       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE archive_items (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'note'
               CHECK (kind IN ('note','meeting','link','file')),
  title      TEXT,
  body       TEXT,
  url        TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id    TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
  day_key    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_archive_day  ON archive_items(day_key) WHERE deleted_at IS NULL;
CREATE INDEX idx_archive_task ON archive_items(task_id) WHERE deleted_at IS NULL;

CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  archive_id TEXT REFERENCES archive_items(id) ON DELETE CASCADE,
  file_name  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search: tokens holds the bigram-folded search string.
-- SQLite's unicode61 tokenizer cannot index Chinese (verified: neither a full
-- run nor a substring matches), so CJK text is folded into adjacent bigrams.
-- Folding algorithm: src/core/db/tokens.ts. Rationale: docs/design.md section 6.5.
CREATE VIRTUAL TABLE search_fts USING fts5(
  doc_id      UNINDEXED,
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  title,
  body,
  tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
