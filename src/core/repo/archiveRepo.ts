// 资料归档仓储：会议纪要、链接、截图、文件等非任务信息。
// 可关联到项目/任务，也可游离存在（会议纪要往往先归档再决定归属）。

import type { DatabaseSync } from 'node:sqlite';
import { insert, queryAll, queryOne, updateById } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { ARCHIVE_KINDS, enumGuard } from '../domain/types.ts';
import type { ArchiveItem, ArchiveKind } from '../domain/types.ts';
import { requireById, softDeleteOrThrow } from './helpers.ts';

const TABLE = 'archive_items';

interface ArchiveRow {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  url: string | null;
  project_id: string | null;
  task_id: string | null;
  day_key: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const assertKind = enumGuard(ARCHIVE_KINDS, '资料类型');

function toArchive(row: ArchiveRow): ArchiveItem {
  assertKind(row.kind);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    projectId: row.project_id,
    taskId: row.task_id,
    dayKey: row.day_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface ArchiveCreate {
  kind?: ArchiveKind;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  /** 归属日键，由服务层按日界算出 */
  dayKey?: string | null;
}

export interface ArchivePatch {
  kind?: ArchiveKind;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  dayKey?: string | null;
}

export function createArchive(database: DatabaseSync, input: ArchiveCreate): ArchiveItem {
  const id = newId();
  const now = nowIso();
  insert(database, TABLE, {
    id,
    kind: input.kind ?? 'note',
    title: input.title ?? null,
    body: input.body ?? null,
    url: input.url ?? null,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    day_key: input.dayKey ?? null,
    created_at: now,
    updated_at: now,
  });
  return requireById(getArchive(database, id), '资料条目', id);
}

export function getArchive(database: DatabaseSync, id: string): ArchiveItem | undefined {
  const row = queryOne<ArchiveRow>(database, `SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toArchive(row);
}

export interface ArchiveFilter {
  taskId?: string;
  projectId?: string;
  dayKey?: string;
  limit?: number;
}

export function listArchives(database: DatabaseSync, filter: ArchiveFilter = {}): ArchiveItem[] {
  const conditions = ['deleted_at IS NULL'];
  const params: (string | number | null)[] = [];
  if (filter.taskId !== undefined) {
    conditions.push('task_id = ?');
    params.push(filter.taskId);
  }
  if (filter.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.dayKey !== undefined) {
    conditions.push('day_key = ?');
    params.push(filter.dayKey);
  }
  const rows = queryAll<ArchiveRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    filter.limit ?? 100,
  );
  return rows.map(toArchive);
}

/** 在时间区间内创建的资料条目（每日日志汇总用） */
export function listArchivesCreatedBetween(database: DatabaseSync, startIso: string, endIso: string): ArchiveItem[] {
  const rows = queryAll<ArchiveRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
    startIso,
    endIso,
  );
  return rows.map(toArchive);
}

export function updateArchive(database: DatabaseSync, id: string, patch: ArchivePatch): ArchiveItem {
  requireById(getArchive(database, id), '资料条目', id);
  updateById(database, TABLE, id, {
    kind: patch.kind,
    title: patch.title,
    body: patch.body,
    url: patch.url,
    project_id: patch.projectId,
    task_id: patch.taskId,
    day_key: patch.dayKey,
  });
  return requireById(getArchive(database, id), '资料条目', id);
}

export function deleteArchive(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, TABLE, '资料条目', id);
}
