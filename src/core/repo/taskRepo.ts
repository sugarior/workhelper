// 任务仓储：可独立交付、有完成判据的工作单元。

import type { DatabaseSync } from 'node:sqlite';
import { execute, insert, queryAll, queryOne, updateById } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { enumGuard, PRIORITIES, TASK_STATUSES } from '../domain/types.ts';
import type { Priority, Task, TaskStatus } from '../domain/types.ts';
import { nextSortOrder, requireById, reorderWithin, softDeleteOrThrow } from './helpers.ts';

const TABLE = 'tasks';

interface TaskRow {
  id: string;
  project_id: string | null;
  title: string;
  detail: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  due_date: string | null;
  estimate_minutes: number | null;
  blocked_reason: string | null;
  planned_for: string | null;
  completed_at: string | null;
  sort_order: number;
  source_inbox_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const assertStatus = enumGuard(TASK_STATUSES, '任务状态');
const assertPriority = enumGuard(PRIORITIES, '优先级');

function toTask(row: TaskRow): Task {
  assertStatus(row.status);
  assertPriority(row.priority);
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    dueDate: row.due_date,
    estimateMinutes: row.estimate_minutes,
    blockedReason: row.blocked_reason,
    plannedFor: row.planned_for,
    completedAt: row.completed_at,
    sortOrder: row.sort_order,
    sourceInboxId: row.source_inbox_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface TaskCreate {
  title: string;
  projectId?: string | null;
  detail?: string | null;
  priority?: Priority;
  dueAt?: string | null;
  dueDate?: string | null;
  estimateMinutes?: number | null;
  plannedFor?: string | null;
  sourceInboxId?: string | null;
}

export interface TaskPatch {
  title?: string;
  projectId?: string | null;
  detail?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  dueAt?: string | null;
  dueDate?: string | null;
  estimateMinutes?: number | null;
  blockedReason?: string | null;
  plannedFor?: string | null;
  completedAt?: string | null;
}

export function createTask(database: DatabaseSync, input: TaskCreate): Task {
  const id = newId();
  const now = nowIso();
  insert(database, TABLE, {
    id,
    project_id: input.projectId ?? null,
    title: input.title,
    detail: input.detail ?? null,
    status: 'todo',
    priority: input.priority ?? 'normal',
    due_at: input.dueAt ?? null,
    due_date: input.dueDate ?? null,
    estimate_minutes: input.estimateMinutes ?? null,
    planned_for: input.plannedFor ?? null,
    source_inbox_id: input.sourceInboxId ?? null,
    sort_order: nextSortOrder(database, TABLE, 'project_id', input.projectId ?? undefined),
    created_at: now,
    updated_at: now,
  });
  return requireById(getTask(database, id), '任务', id);
}

export function getTask(database: DatabaseSync, id: string): Task | undefined {
  const row = queryOne<TaskRow>(database, `SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toTask(row);
}

export interface TaskFilter {
  status?: TaskStatus;
  projectId?: string | null;
  plannedFor?: string;
  /** 截止日键 <= 该值（用于逾期查询，配合 status 排除终态） */
  dueOnOrBefore?: string;
  /** 截止日键 = 该值 */
  dueOn?: string;
  limit?: number;
}

export function listTasks(database: DatabaseSync, filter: TaskFilter = {}): Task[] {
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: (string | number | null)[] = [];

  if (filter.status !== undefined) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.projectId !== undefined) {
    if (filter.projectId === null) {
      conditions.push('project_id IS NULL');
    } else {
      conditions.push('project_id = ?');
      params.push(filter.projectId);
    }
  }
  if (filter.plannedFor !== undefined) {
    conditions.push('planned_for = ?');
    params.push(filter.plannedFor);
  }
  if (filter.dueOnOrBefore !== undefined) {
    conditions.push('due_date IS NOT NULL AND due_date <= ?');
    params.push(filter.dueOnOrBefore);
  }
  if (filter.dueOn !== undefined) {
    conditions.push('due_date = ?');
    params.push(filter.dueOn);
  }

  const limit = filter.limit ?? 500;
  const rows = queryAll<TaskRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE ${conditions.join(' AND ')}
     ORDER BY sort_order ASC, created_at ASC LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map(toTask);
}

/** 未结束的任务（用于"今天该做什么"与逾期判断） */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked'];

/** 按状态集合查询，供今日视图使用 */
export function listTasksByStatuses(
  database: DatabaseSync,
  statuses: readonly TaskStatus[],
  extra: { dueOnOrBefore?: string; dueOn?: string } = {},
): Task[] {
  if (statuses.length === 0) return [];
  const conditions = ['deleted_at IS NULL', `status IN (${statuses.map(() => '?').join(', ')})`];
  const params: (string | number | null)[] = [...statuses];
  if (extra.dueOnOrBefore !== undefined) {
    conditions.push('due_date IS NOT NULL AND due_date <= ?');
    params.push(extra.dueOnOrBefore);
  }
  if (extra.dueOn !== undefined) {
    conditions.push('due_date = ?');
    params.push(extra.dueOn);
  }
  const rows = queryAll<TaskRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE ${conditions.join(' AND ')} ORDER BY due_date ASC, sort_order ASC`,
    ...params,
  );
  return rows.map(toTask);
}

/** 在时间区间内完成的任务（每日日志汇总用） */
export function listTasksCompletedBetween(database: DatabaseSync, startIso: string, endIso: string): Task[] {
  const rows = queryAll<TaskRow>(
    database,
    `SELECT * FROM ${TABLE}
     WHERE deleted_at IS NULL AND status = 'done' AND completed_at IS NOT NULL
       AND completed_at >= ? AND completed_at < ?
     ORDER BY completed_at ASC`,
    startIso,
    endIso,
  );
  return rows.map(toTask);
}

/** 在时间区间内创建的任务（每日日志汇总用） */
export function listTasksCreatedBetween(database: DatabaseSync, startIso: string, endIso: string): Task[] {
  const rows = queryAll<TaskRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
    startIso,
    endIso,
  );
  return rows.map(toTask);
}

/** 未结束且到期日不晚于给定日键的任务（顺延项查询） */
export function listOpenTasksDueOnOrBefore(database: DatabaseSync, dayKey: string): Task[] {
  return listTasksByStatuses(database, OPEN_TASK_STATUSES, { dueOnOrBefore: dayKey });
}

export function updateTask(database: DatabaseSync, id: string, patch: TaskPatch): Task {
  requireById(getTask(database, id), '任务', id);
  updateById(database, TABLE, id, {
    title: patch.title,
    project_id: patch.projectId,
    detail: patch.detail,
    status: patch.status,
    priority: patch.priority,
    due_at: patch.dueAt,
    due_date: patch.dueDate,
    estimate_minutes: patch.estimateMinutes,
    blocked_reason: patch.blockedReason,
    planned_for: patch.plannedFor,
    completed_at: patch.completedAt,
  });
  return requireById(getTask(database, id), '任务', id);
}

export function deleteTask(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, TABLE, '任务', id);
}

export function reorderTask(database: DatabaseSync, id: string, beforeId: string | null): number {
  const task = requireById(getTask(database, id), '任务', id);
  return reorderWithin(database, TABLE, id, beforeId, {
    column: 'project_id',
    value: task.projectId ?? '',
  });
}

/** 把某项目下的任务全部移到无项目状态（软删除项目时用） */
export function countByProject(database: DatabaseSync, projectId: string): number {
  const row = queryOne<{ c: number }>(
    database,
    `SELECT COUNT(*) AS c FROM ${TABLE} WHERE project_id = ? AND deleted_at IS NULL`,
    projectId,
  );
  return Number(row?.c ?? 0);
}

/** 供服务层做状态流转时直接改状态（含完成水印与阻塞原因） */
export function applyStatus(
  database: DatabaseSync,
  id: string,
  status: TaskStatus,
  options: { completedAt?: string | null; blockedReason?: string | null } = {},
): Task {
  return updateTask(database, id, {
    status,
    completedAt: options.completedAt,
    blockedReason: options.blockedReason,
  });
}

/** 手工加入/移出"今日" */
export function setPlannedFor(database: DatabaseSync, id: string, dayKey: string | null): Task {
  return updateTask(database, id, { plannedFor: dayKey });
}

/** 业务自检：状态为 blocked 却没有阻塞原因的任务 */
export function findBlockedWithoutReason(database: DatabaseSync): Task[] {
  const rows = queryAll<TaskRow>(
    database,
    `SELECT * FROM ${TABLE}
     WHERE deleted_at IS NULL AND status = 'blocked'
       AND (blocked_reason IS NULL OR TRIM(blocked_reason) = '')`,
  );
  return rows.map(toTask);
}

/** 业务自检：已完成却没有完成时间的任务 */
export function findDoneWithoutTimestamp(database: DatabaseSync): Task[] {
  const rows = queryAll<TaskRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL AND status = 'done' AND completed_at IS NULL`,
  );
  return rows.map(toTask);
}
