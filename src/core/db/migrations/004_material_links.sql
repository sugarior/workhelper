-- Material links: a material must be attached to at least one task or project
-- (requirements 4.1 M1), and one material may be attached to several (4.2 D2).
--
-- target_id is polymorphic over (tasks, projects), therefore it has NO foreign
-- key: SQLite has no polymorphic FK. Consequences, both handled in application
-- code rather than by the database:
--   1. deleting a task/project must clean up its link rows (repository layer)
--   2. an orphaned link is possible in principle, so `verify` reports them
--
-- The "at least one link" rule is an aggregate constraint (a material could have
-- zero rows here), which SQLite cannot express either. It is enforced by the
-- service layer, with a `verify` self-check as the safety net.

CREATE TABLE archive_links (
  archive_id  TEXT NOT NULL REFERENCES archive_items(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('task', 'project')),
  target_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (archive_id, target_type, target_id)
);

CREATE INDEX idx_archive_links_target ON archive_links(target_type, target_id);

-- Backfill from the legacy single-value columns, then drop them.
-- From here on, archive_links is the ONLY source of truth for attachment.
INSERT OR IGNORE INTO archive_links (archive_id, target_type, target_id, created_at)
SELECT id, 'task', task_id, created_at FROM archive_items WHERE task_id IS NOT NULL;

INSERT OR IGNORE INTO archive_links (archive_id, target_type, target_id, created_at)
SELECT id, 'project', project_id, created_at FROM archive_items WHERE project_id IS NOT NULL;

-- SQLite cannot drop a column that is referenced by an index, so drop the
-- indexes first. Both were created in 001_init.sql.
DROP INDEX IF EXISTS idx_archive_task;

ALTER TABLE archive_items DROP COLUMN task_id;
ALTER TABLE archive_items DROP COLUMN project_id;

-- `body` and `url` are intentionally kept: the backfill in 003 only turned
-- pointer-looking values into entries, so prose may still live in `body`.
-- Dropping them would lose that text. They are no longer read by new code.
