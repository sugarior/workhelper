// 项目仓储：一件事 / 一个阶段 / 一条工作线。

import type { DatabaseSync } from 'node:sqlite';
import { execute, insert, queryAll, queryOne, updateById } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { enumGuard, PRIORITIES, PROJECT_STATUSES } from '../domain/types.ts';
import type { Priority, Project, ProjectStatus } from '../domain/types.ts';
import { nextSortOrder, requireById, reorderWithin, softDeleteOrThrow } from './helpers.ts';

const TABLE = 'projects';

interface ProjectRow {
  id: string;
  title: string;
  goal: string | null;
  status: string;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const assertStatus = enumGuard(PROJECT_STATUSES, '项目状态');
const assertPriority = enumGuard(PRIORITIES, '优先级');

function toProject(row: ProjectRow): Project {
  assertStatus(row.status);
  assertPriority(row.priority);
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    priority: row.priority,
    startDate: row.start_date,
    dueDate: row.due_date,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface ProjectCreate {
  title: string;
  goal?: string | null;
  priority?: Priority;
  startDate?: string | null;
  dueDate?: string | null;
}

export interface ProjectPatch {
  title?: string;
  goal?: string | null;
  status?: ProjectStatus;
  priority?: Priority;
  startDate?: string | null;
  dueDate?: string | null;
}

export function createProject(database: DatabaseSync, input: ProjectCreate): Project {
  const id = newId();
  const now = nowIso();
  insert(database, TABLE, {
    id,
    title: input.title,
    goal: input.goal ?? null,
    status: 'active',
    priority: input.priority ?? 'normal',
    start_date: input.startDate ?? null,
    due_date: input.dueDate ?? null,
    sort_order: nextSortOrder(database, TABLE),
    created_at: now,
    updated_at: now,
  });
  return requireById(getProject(database, id), '项目', id);
}

export function getProject(database: DatabaseSync, id: string): Project | undefined {
  const row = queryOne<ProjectRow>(database, `SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toProject(row);
}

export function listProjects(database: DatabaseSync, options: { status?: ProjectStatus } = {}): Project[] {
  const where = options.status === undefined ? '' : ' AND status = ?';
  const params = options.status === undefined ? [] : [options.status];
  const rows = queryAll<ProjectRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL${where} ORDER BY sort_order ASC, created_at ASC`,
    ...params,
  );
  return rows.map(toProject);
}

export function updateProject(database: DatabaseSync, id: string, patch: ProjectPatch): Project {
  requireById(getProject(database, id), '项目', id);
  updateById(database, TABLE, id, {
    title: patch.title,
    goal: patch.goal,
    status: patch.status,
    priority: patch.priority,
    start_date: patch.startDate,
    due_date: patch.dueDate,
  });
  return requireById(getProject(database, id), '项目', id);
}

export function deleteProject(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, TABLE, '项目', id);
}

/** 拖拽排序：把 id 插到 beforeId 之前 */
export function reorderProject(database: DatabaseSync, id: string, beforeId: string | null): number {
  return reorderWithin(database, TABLE, id, beforeId);
}

/** 项目下的任务统计，用于列表展示进度 */
export function projectTaskCounts(database: DatabaseSync, projectId: string): { total: number; done: number } {
  const row = queryOne<{ total: number; done: number }>(
    database,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
     FROM tasks WHERE project_id = ? AND deleted_at IS NULL`,
    projectId,
  );
  return { total: Number(row?.total ?? 0), done: Number(row?.done ?? 0) };
}

/** 把项目下未删除任务的归属清空（软删除项目时用，避免任务被一起隐藏） */
export function detachTasks(database: DatabaseSync, projectId: string): number {
  const result = execute(
    database,
    `UPDATE tasks SET project_id = NULL, updated_at = ? WHERE project_id = ? AND deleted_at IS NULL`,
    nowIso(),
    projectId,
  );
  return result.changes;
}
