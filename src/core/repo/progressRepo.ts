// 进展记录仓储：可挂在项目 / 任务 / 子任务任意一层，且恰好挂一个。
// "恰好一个"由数据库 CHECK 约束保证（见 001_init.sql），此处只负责正确填列。

import type { DatabaseSync } from 'node:sqlite';
import { queryAll, queryOne, insert } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { enumGuard, PROGRESS_KINDS } from '../domain/types.ts';
import type { ProgressEntry, ProgressKind, ProgressTarget } from '../domain/types.ts';
import { requireById, softDeleteOrThrow } from './helpers.ts';

const TABLE = 'progress_entries';

interface ProgressRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  subtask_id: string | null;
  kind: string;
  body: string;
  day_key: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const assertKind = enumGuard(PROGRESS_KINDS, '进展类型');

function toEntry(row: ProgressRow): ProgressEntry {
  assertKind(row.kind);
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    kind: row.kind,
    body: row.body,
    dayKey: row.day_key,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** 把目标层级映射到对应的外键列 */
function targetColumn(kind: ProgressTarget['kind']): 'project_id' | 'task_id' | 'subtask_id' {
  switch (kind) {
    case 'project':
      return 'project_id';
    case 'task':
      return 'task_id';
    case 'subtask':
      return 'subtask_id';
  }
}

export interface ProgressCreate {
  target: ProgressTarget;
  kind: ProgressKind;
  body: string;
  /** 归属日键，由服务层按日界算出 */
  dayKey: string;
  /** 真实发生时刻；补录时可与 dayKey 不一致 */
  occurredAt?: string;
}

export function createProgress(database: DatabaseSync, input: ProgressCreate): ProgressEntry {
  const id = newId();
  const now = nowIso();
  const occurredAt = input.occurredAt ?? now;
  insert(database, TABLE, {
    id,
    [targetColumn(input.target.kind)]: input.target.id,
    kind: input.kind,
    body: input.body,
    day_key: input.dayKey,
    occurred_at: occurredAt,
    created_at: now,
    updated_at: now,
  });
  return requireById(getProgress(database, id), '进展记录', id);
}

export function getProgress(database: DatabaseSync, id: string): ProgressEntry | undefined {
  const row = queryOne<ProgressRow>(database, `SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toEntry(row);
}

/** 某个目标下的进展时间线，最新的在最前 */
export function listProgressForTarget(database: DatabaseSync, target: ProgressTarget, limit = 100): ProgressEntry[] {
  const column = targetColumn(target.kind);
  const rows = queryAll<ProgressRow>(
    database,
    `SELECT * FROM ${TABLE}
     WHERE ${column} = ? AND deleted_at IS NULL
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT ?`,
    target.id,
    limit,
  );
  return rows.map(toEntry);
}

/** 任务的全部进展，含直接挂在其子任务上的记录（时间线视图用） */
export function listProgressForTaskTree(database: DatabaseSync, taskId: string, limit = 200): ProgressEntry[] {
  const rows = queryAll<ProgressRow>(
    database,
    `SELECT * FROM ${TABLE}
     WHERE deleted_at IS NULL
       AND (task_id = ? OR subtask_id IN (SELECT id FROM subtasks WHERE task_id = ? AND deleted_at IS NULL))
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT ?`,
    taskId,
    taskId,
    limit,
  );
  return rows.map(toEntry);
}

/** 按归属日键取当天的全部进展（每日日志时间线用） */
export function listProgressByDay(database: DatabaseSync, dayKey: string): ProgressEntry[] {
  const rows = queryAll<ProgressRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE day_key = ? AND deleted_at IS NULL ORDER BY occurred_at ASC, created_at ASC`,
    dayKey,
  );
  return rows.map(toEntry);
}

/** 按真实时刻区间取进展（跨日界的精确汇总用） */
export function listProgressBetween(database: DatabaseSync, startIso: string, endIso: string): ProgressEntry[] {
  const rows = queryAll<ProgressRow>(
    database,
    `SELECT * FROM ${TABLE}
     WHERE deleted_at IS NULL AND occurred_at >= ? AND occurred_at < ?
     ORDER BY occurred_at ASC`,
    startIso,
    endIso,
  );
  return rows.map(toEntry);
}

/** 仍未解除的卡点：任务当前状态仍为 blocked 的那些卡点记录 */
export function listOpenBlockers(database: DatabaseSync): ProgressEntry[] {
  const rows = queryAll<ProgressRow>(
    database,
    `SELECT p.* FROM ${TABLE} p
     JOIN tasks t ON t.id = p.task_id AND t.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.kind = 'blocker' AND t.status = 'blocked'
     ORDER BY p.occurred_at DESC`,
  );
  return rows.map(toEntry);
}

/** 某个任务下最近的卡点（解除阻塞时用于回顾原因） */
export function latestBlockerForTask(database: DatabaseSync, taskId: string): ProgressEntry | undefined {
  const row = queryOne<ProgressRow>(
    database,
    `SELECT * FROM ${TABLE}
     WHERE task_id = ? AND kind = 'blocker' AND deleted_at IS NULL
     ORDER BY occurred_at DESC LIMIT 1`,
    taskId,
  );
  return row === undefined ? undefined : toEntry(row);
}

export function countProgressForTarget(database: DatabaseSync, target: ProgressTarget): number {
  const column = targetColumn(target.kind);
  const row = queryOne<{ c: number }>(
    database,
    `SELECT COUNT(*) AS c FROM ${TABLE} WHERE ${column} = ? AND deleted_at IS NULL`,
    target.id,
  );
  return Number(row?.c ?? 0);
}

export function deleteProgress(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, TABLE, '进展记录', id);
}

export { targetColumn };
