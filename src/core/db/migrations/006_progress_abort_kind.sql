-- Add the 'abort' progress kind.
--
-- Why: "abort" (this task is not going to be done, but keep the record and its
-- history) previously had NO interface entry at all. The user's observation was
-- that the four note kinds (progress / blocker / decision / waiting) are more
-- than a single person actually needs, and that "waiting" overlaps with
-- "blocker" while "abort" had no way in. So 'waiting' is retired from the
-- selectable options and 'abort' takes its place.
--
-- 'waiting' is deliberately KEPT in the constraint: old records still contain
-- it and must remain readable. Only new entries stop using it.
--
-- This needs a table rebuild because SQLite cannot alter a CHECK constraint.
-- Follows the same approach as migration 002.
--
-- Ordering matters: DROP the old indexes before renaming the table, otherwise
-- the index names stay attached to the old table and the new one cannot create
-- them. Then recreate them exactly as in 001_init.sql.

DROP INDEX IF EXISTS idx_progress_task;
DROP INDEX IF EXISTS idx_progress_project;
DROP INDEX IF EXISTS idx_progress_subtask;
DROP INDEX IF EXISTS idx_progress_day;

ALTER TABLE progress_entries RENAME TO progress_entries_old;

CREATE TABLE progress_entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id)    ON DELETE CASCADE,
  subtask_id  TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'progress'
                CHECK (kind IN ('progress','blocker','decision','waiting','abort')),
  body        TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  CHECK ((project_id IS NOT NULL) + (task_id IS NOT NULL) + (subtask_id IS NOT NULL) = 1)
);

INSERT INTO progress_entries
  (id, project_id, task_id, subtask_id, kind, body, day_key, occurred_at, created_at, updated_at, deleted_at)
SELECT
  id, project_id, task_id, subtask_id, kind, body, day_key, occurred_at, created_at, updated_at, deleted_at
FROM progress_entries_old;

DROP TABLE progress_entries_old;

CREATE INDEX idx_progress_task    ON progress_entries(task_id, occurred_at DESC)    WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_project ON progress_entries(project_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_subtask ON progress_entries(subtask_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_progress_day     ON progress_entries(day_key)                      WHERE deleted_at IS NULL;
