// 资料仓储：资料本身（标题 + 若干入口 + 若干挂靠）。
//
// 注意分工：本文件的 archive_items 只承载资料的**身份**（标题、kind、日键）。
// **入口在 materialRepo 的 archive_entries**，**挂靠在 archive_links**。
// 迁移 004 之后 archive_items 上不再有 task_id / project_id —— 单值关联已彻底废弃，
// 因为一条资料可以挂靠多个任务/项目（需求 §4.2 D2）。
//
// body / url 两列仍留在表上（迁移 004 特意没删：003 只把"像指针"的值转成入口，
// 散文类正文还在 body 里，删掉就丢内容）。**新代码不再读写它们**，
// 它们只作为历史数据的落脚点，等资料页的清理流程处理。

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
    dayKey: row.day_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface ArchiveCreate {
  kind?: ArchiveKind;
  title?: string | null;
  dayKey?: string | null;
}

export interface ArchivePatch {
  kind?: ArchiveKind;
  title?: string | null;
  dayKey?: string | null;
}

export function createArchive(database: DatabaseSync, input: ArchiveCreate): ArchiveItem {
  const id = newId();
  const now = nowIso();
  insert(database, TABLE, {
    id,
    kind: input.kind ?? 'note',
    title: input.title ?? null,
    day_key: input.dayKey ?? null,
    created_at: now,
    updated_at: now,
  });
  return requireById(getArchive(database, id), '资料', id);
}

export function getArchive(database: DatabaseSync, id: string): ArchiveItem | undefined {
  const row = queryOne<ArchiveRow>(database, `SELECT * FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toArchive(row);
}

export interface ArchiveFilter {
  dayKey?: string;
  limit?: number;
}

export function listArchives(database: DatabaseSync, filter: ArchiveFilter = {}): ArchiveItem[] {
  const conditions = ['deleted_at IS NULL'];
  const params: (string | number | null)[] = [];
  if (filter.dayKey !== undefined) {
    conditions.push('day_key = ?');
    params.push(filter.dayKey);
  }
  const rows = queryAll<ArchiveRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    filter.limit ?? 200,
  );
  return rows.map(toArchive);
}

/** 批量按 id 读取（资料页按挂靠筛选后回表用），保持传入顺序 */
export function listArchivesByIds(database: DatabaseSync, ids: readonly string[]): ArchiveItem[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = queryAll<ArchiveRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    ...ids,
  );
  const byId = new Map(rows.map((row) => [row.id, toArchive(row)]));
  return ids.map((id) => byId.get(id)).filter((item): item is ArchiveItem => item !== undefined);
}

/** 在时间区间内创建的资料（每日日志汇总用） */
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
  requireById(getArchive(database, id), '资料', id);
  updateById(database, TABLE, id, {
    kind: patch.kind,
    title: patch.title,
    day_key: patch.dayKey,
  });
  return requireById(getArchive(database, id), '资料', id);
}

export function deleteArchive(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, TABLE, '资料', id);
}
