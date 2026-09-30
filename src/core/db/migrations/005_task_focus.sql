-- Task focus: "which one am I actually working on right now" (requirements 5.2.1).
--
-- Why a separate field instead of reusing status = 'doing':
--   * `doing` may have several tasks at once, while "currently working on"
--     is necessarily a single one - a multi-valued field cannot express that.
--   * Being interrupted is the norm (requirements 3.1), so after an
--     interruption `doing` no longer means "the thing I was on".
--
-- The focus is deliberately NOT a status: focus is "where my attention is",
-- status is "how far this thing has got". Mixing them forces the state
-- machine to carry responsibilities that are not its own.

ALTER TABLE tasks ADD COLUMN focused_at TEXT;

-- Day key of the moment focus was set. Used for "clear on the daily boundary"
-- without a background timer: reading the focus compares this with today's key,
-- so a restart or a machine that was off overnight is handled correctly too.
ALTER TABLE tasks ADD COLUMN focused_day_key TEXT;

-- At most ONE task may carry focus, enforced by the database rather than by
-- service-layer discipline alone. Unlike "a material must be linked" (an
-- aggregate rule SQLite cannot express), this is a single-row constraint, so
-- the database is the right place for it. The index is on a constant
-- expression, so every focused row indexes to 1 and a second one collides.
CREATE UNIQUE INDEX idx_tasks_single_focus ON tasks((1)) WHERE focused_at IS NOT NULL;
