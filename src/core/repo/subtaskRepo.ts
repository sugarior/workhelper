// 子任务仓储：任务下的可执行步骤。

import type { DatabaseSync } from 'node:sqlite';
import { queryAll, queryOne, insert, updateById } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { enumGuard, SUBTASK_STATUSES } from '../domain/types.ts';
import type { Subtask, SubtaskStatus } from '../domain/types.ts';
import { nextSortOrder, requireById, reorderWithin, softDeleteOrThrow } from './helpers.ts';

const TABLE = 'subtasks';

interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const assertStatus = enumGuard(SUBTASK_STATUSES, '子任务状态');

function toSubtask(row: SubtaskRow): Subtask {
  assertStatus(row.status);
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    status: row.status,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface SubtaskCreate {
  taskId: string;
  title: string;
  dueDate?: string | null;
}

export interface SubtaskPatch {
  title?: string;
  status?: SubtaskStatus;
  dueDate?: string | null;
  completedAt?: string | null;
}

export function createSubtask(database: DatabaseSync, input: SubtaskCreate): Subtask {
  const id = newId();
  const now = nowIso();
  insert(database, TABLE, {
    id,
    task_id: input.taskId,
    title: input.title,
    status: 'todo',
    due_date: input.dueDate ?? null,
    sort_order: nextSortOrder(database, TABLE, 'task_id', input.taskId),
    created_at: now,
    updated_at: now,
  });
  return requireById(getSubtask(database, id), '子任务', id);
}

export function getSubtask(database: DatabaseSync, id: string): Subtask | undefined {
  const row = queryOne<SubtaskRow>(database, `SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toSubtask(row);
}

export function listSubtasks(database: DatabaseSync, taskId: string): Subtask[] {
  const rows = queryAll<SubtaskRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE task_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`,
    taskId,
  );
  return rows.map(toSubtask);
}

/** 在时间区间内完成的子任务，附带所属任务标题（每日日志汇总用） */
export function listSubtasksCompletedBetween(
  database: DatabaseSync,
  startIso: string,
  endIso: string,
): { subtask: Subtask; taskTitle: string }[] {
  const rows = queryAll<SubtaskRow & { task_title: string }>(
    database,
    `SELECT s.*, t.title AS task_title FROM ${TABLE} s
     JOIN tasks t ON t.id = s.task_id
     WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
       AND s.status = 'done' AND s.completed_at IS NOT NULL
       AND s.completed_at >= ? AND s.completed_at < ?
     ORDER BY s.completed_at ASC`,
    startIso,
    endIso,
  );
  return rows.map((row) => ({ subtask: toSubtask(row), taskTitle: row.task_title }));
}

export function updateSubtask(database: DatabaseSync, id: string, patch: SubtaskPatch): Subtask {
  requireById(getSubtask(database, id), '子任务', id);
  updateById(database, TABLE, id, {
    title: patch.title,
    status: patch.status,
    due_date: patch.dueDate,
    completed_at: patch.completedAt,
  });
  return requireById(getSubtask(database, id), '子任务', id);
}

/** 设置完成状态并维护完成时间戳（时间戳口径与任务一致：进入 done 水印，离开清除） */
export function setSubtaskStatus(
  database: DatabaseSync,
  id: string,
  status: SubtaskStatus,
  nowIsoString: string,
): Subtask {
  const current = requireById(getSubtask(database, id), '子任务', id);
  const completedAt = status === 'done' ? (current.completedAt ?? nowIsoString) : null;
  return updateSubtask(database, id, { status, completedAt });
}

export function deleteSubtask(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, TABLE, '子任务', id);
}

export function reorderSubtask(database: DatabaseSync, id: string, beforeId: string | null): number {
  const subtask = requireById(getSubtask(database, id), '子任务', id);
  return reorderWithin(database, TABLE, id, beforeId, { column: 'task_id', value: subtask.taskId });
}

export function countSubtasks(database: DatabaseSync, taskId: string): { total: number; done: number } {
  const row = queryOne<{ total: number; done: number }>(
    database,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
     FROM ${TABLE} WHERE task_id = ? AND deleted_at IS NULL`,
    taskId,
  );
  return { total: Number(row?.total ?? 0), done: Number(row?.done ?? 0) };
}

/** 级联完成：把任务下所有未完成子任务标记为完成（服务层在需要时调用） */
export function completeAll(database: DatabaseSync, taskId: string, nowIsoString: string): number {
  const pending = listSubtasks(database, taskId).filter((item) => item.status !== 'done');
  for (const item of pending) {
    updateSubtask(database, item.id, { status: 'done', completedAt: nowIsoString });
  }
  return pending.length;
}
