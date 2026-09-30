// 回收站：软删除记录的查看、恢复与到期清理。
// 单机数据没有云端兜底，误删是唯一不可逆的失败，因此删除一律先软删。

import type { DatabaseSync } from 'node:sqlite';
import { execute, queryAll } from '../db/connection.ts';
import { ENTITY_TYPES, enumGuard } from '../domain/types.ts';
import type { EntityType } from '../domain/types.ts';
import { NotFoundError, ValidationError } from '../domain/errors.ts';

/** 回收站保留天数 */
export const TRASH_RETENTION_DAYS = 30;

interface TableSpec {
  table: string;
  label: string;
  /** 用于在回收站列表里显示的标题列 */
  titleColumn: string;
}

/**
 * 参与回收站的实体及其实表。
 * 注意 progress_entries / subtasks 是随父对象级联清理的，
 * 它们单独进回收站意义不大，但既然支持软删除就一并暴露，避免"删了找不回"。
 */
const TABLES: Readonly<Record<EntityType, TableSpec>> = {
  project: { table: 'projects', label: '项目', titleColumn: 'title' },
  task: { table: 'tasks', label: '任务', titleColumn: 'title' },
  subtask: { table: 'subtasks', label: '子任务', titleColumn: 'title' },
  progress: { table: 'progress_entries', label: '进展记录', titleColumn: 'body' },
  inbox: { table: 'inbox_items', label: '收件箱条目', titleColumn: 'body' },
  archive: { table: 'archive_items', label: '资料条目', titleColumn: 'COALESCE(title, body)' },
  log: { table: 'daily_logs', label: '每日日志', titleColumn: 'day_key' },
};

const assertEntityType = enumGuard(ENTITY_TYPES, '实体类型');

export interface TrashEntry {
  entityType: EntityType;
  entityId: string;
  label: string;
  title: string;
  deletedAt: string;
  /** 距自动清理还剩多少天（可能为负，表示已过期待清理） */
  daysLeft: number;
}

export interface TrashFilter {
  entityType?: EntityType;
  limit?: number;
}

function specOf(entityType: string): TableSpec {
  assertEntityType(entityType);
  return TABLES[entityType];
}

function daysLeft(deletedAt: string, now: Date): number {
  const deleted = new Date(deletedAt).getTime();
  const elapsedDays = Math.floor((now.getTime() - deleted) / (24 * 60 * 60 * 1000));
  return TRASH_RETENTION_DAYS - elapsedDays;
}

/** 列出回收站内容，最近删除的在前 */
export function listTrash(database: DatabaseSync, filter: TrashFilter = {}, now: Date = new Date()): TrashEntry[] {
  const targets = filter.entityType === undefined ? ENTITY_TYPES : [filter.entityType];
  const entries: TrashEntry[] = [];

  for (const entityType of targets) {
    const spec = TABLES[entityType];
    const rows = queryAll<{ id: string; deleted_at: string; title: string | null }>(
      database,
      `SELECT id, deleted_at, ${spec.titleColumn} AS title FROM ${spec.table}
       WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC
       LIMIT ?`,
      filter.limit ?? 200,
    );
    for (const row of rows) {
      entries.push({
        entityType,
        entityId: row.id,
        label: spec.label,
        title: row.title ?? '',
        deletedAt: row.deleted_at,
        daysLeft: daysLeft(row.deleted_at, now),
      });
    }
  }

  entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return entries;
}

export function countTrash(database: DatabaseSync): number {
  let total = 0;
  for (const entityType of ENTITY_TYPES) {
    const spec = TABLES[entityType];
    const row = database
      .prepare(`SELECT COUNT(*) AS c FROM ${spec.table} WHERE deleted_at IS NOT NULL`)
      .get() as { c: number } | undefined;
    total += Number(row?.c ?? 0);
  }
  return total;
}

// ---------- 「已忽略」（需求 F-21b） ----------
//
// 与「已删除」是**两条独立的查询路径**，绝不能合并：
//   · 已删除 → deleted_at IS NOT NULL
//   · 已忽略 → status = 'archived' 且 deleted_at 仍为 NULL
// 上面每个查询都硬编码了 deleted_at IS NOT NULL，因此丢弃的条目
// **永远不可能出现在回收站列表里** —— 这正是"丢弃曾是单向门"的成因（缺陷 R14）。
// 把两种语义硬塞进同一个条件，只会让它们继续互相污染。

export interface IgnoredEntry {
  id: string;
  title: string;
  /** 丢进"已忽略"的时刻 */
  ignoredAt: string;
  /** 原文（有日期被剥离时才有），便于确认丢的是不是这条 */
  rawInput: string | null;
}

/**
 * 列出已忽略的收件箱条目，最近忽略的在前。
 *
 * **不过期**：忽略是"我主动筛掉的"，自动删除等于悄悄抹掉我的判断记录；
 * 回收站里的东西才是"我不小心弄掉的"，那才需要自动兜底。
 */
export function listIgnoredInbox(database: DatabaseSync, limit = 500): IgnoredEntry[] {
  const rows = queryAll<{ id: string; body: string; raw_input: string | null; updated_at: string }>(
    database,
    `SELECT id, body, raw_input, updated_at FROM inbox_items
     WHERE status = 'archived' AND deleted_at IS NULL
     ORDER BY updated_at DESC, rowid DESC
     LIMIT ?`,
    limit,
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.body,
    ignoredAt: row.updated_at,
    rawInput: row.raw_input,
  }));
}

export function countIgnoredInbox(database: DatabaseSync): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS c FROM inbox_items WHERE status = 'archived' AND deleted_at IS NULL`)
    .get() as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** 把忽略的条目放回待处理（"捞回来"）。返回是否真的改了 */
export function restoreIgnoredInbox(database: DatabaseSync, id: string): boolean {
  const result = execute(
    database,
    `UPDATE inbox_items SET status = 'pending', updated_at = ?
     WHERE id = ? AND status = 'archived' AND deleted_at IS NULL`,
    new Date().toISOString(),
    id,
  );
  return result.changes > 0;
}

/** 彻底删除一条已忽略的收件箱条目（物理删除，不可恢复） */
export function purgeIgnoredInbox(database: DatabaseSync, id: string): boolean {
  const result = execute(
    database,
    `DELETE FROM inbox_items WHERE id = ? AND status = 'archived' AND deleted_at IS NULL`,
    id,
  );
  return result.changes > 0;
}

/** 从回收站恢复 */
export function restore(database: DatabaseSync, entityType: EntityType, entityId: string): void {
  const spec = specOf(entityType);
  const result = execute(
    database,
    `UPDATE ${spec.table} SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`,
    new Date().toISOString(),
    entityId,
  );
  if (result.changes === 0) {
    throw new NotFoundError(`回收站中没有该${spec.label}：${entityId}`);
  }
}

/**
 * 清理超过保留期的记录（物理删除）。
 * 只删"已软删除且超过 30 天"的行；级联会带走其子对象。
 * 返回各表清理条数。
 */
export function purgeExpired(database: DatabaseSync, now: Date = new Date()): Record<string, number> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const purged: Record<string, number> = {};

  // 先删子表再删父表：虽然外键是 CASCADE，显式顺序让统计更准确
  const order: EntityType[] = ['progress', 'subtask', 'log', 'inbox', 'archive', 'task', 'project'];
  for (const entityType of order) {
    const spec = TABLES[entityType];
    const result = execute(
      database,
      `DELETE FROM ${spec.table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
      cutoff,
    );
    purged[entityType] = result.changes;
  }
  return purged;
}

/** 立即物理删除一条（用户明确选择"彻底删除"） */
export function purgeOne(database: DatabaseSync, entityType: EntityType, entityId: string): void {
  const spec = specOf(entityType);
  const result = execute(
    database,
    `DELETE FROM ${spec.table} WHERE id = ? AND deleted_at IS NOT NULL`,
    entityId,
  );
  if (result.changes === 0) {
    throw new NotFoundError(`回收站中没有该${spec.label}：${entityId}`);
  }
}

export function assertTrashRetentionDays(days: number): void {
  if (!Number.isInteger(days) || days <= 0) {
    throw new ValidationError(`回收站保留天数必须是正整数，收到：${days}`);
  }
}
