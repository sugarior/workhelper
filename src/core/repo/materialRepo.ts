// 资料入口与挂靠的仓储。
//
// 资料 = "这件事的东西在哪里"的指针（需求 §4.1）。它由两部分组成：
//   · 入口 archive_entries：可打开的目标（本地目录 / 本地文件 / 网址），带自己的注释与排序
//   · 挂靠 archive_links：关联到哪些任务/项目（至少一个，可多个）
//
// 两条硬规则在本层的体现：
//   M1 必须挂靠 —— 本层提供 countLinks / listOrphanArchives 供服务层与自检使用；
//      真正的强制在服务层（跨行约束，数据库表达不了）。
//   M3 只存指针 —— target 原样保存，不做规范化，也不校验可达性
//      （内网路径、未挂载盘符都可能是合法的，见需求 §4.2 D6）。

import type { DatabaseSync } from 'node:sqlite';
import { execute, insert, queryAll, queryOne, updateById } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { enumGuard, MATERIAL_ENTRY_KINDS, MATERIAL_LINK_TYPES } from '../domain/types.ts';
import type { MaterialEntry, MaterialEntryKind, MaterialLink, MaterialLinkType } from '../domain/types.ts';
import { requireById, softDeleteOrThrow } from './helpers.ts';

const ENTRIES = 'archive_entries';
const LINKS = 'archive_links';

interface EntryRow {
  id: string;
  archive_id: string;
  kind: string;
  target: string;
  note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const assertEntryKind = enumGuard(MATERIAL_ENTRY_KINDS, '入口类型');
const assertLinkType = enumGuard(MATERIAL_LINK_TYPES, '挂靠类型');

function toEntry(row: EntryRow): MaterialEntry {
  assertEntryKind(row.kind);
  return {
    id: row.id,
    archiveId: row.archive_id,
    kind: row.kind,
    target: row.target,
    note: row.note,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

// ---------- 入口 ----------

export interface EntryCreate {
  archiveId: string;
  kind: MaterialEntryKind;
  target: string;
  note?: string | null;
}

export function createEntry(database: DatabaseSync, input: EntryCreate): MaterialEntry {
  const id = newId();
  const now = nowIso();
  const next = queryOne<{ m: number | null }>(
    database,
    `SELECT MAX(sort_order) AS m FROM ${ENTRIES} WHERE archive_id = ? AND deleted_at IS NULL`,
    input.archiveId,
  );
  insert(database, ENTRIES, {
    id,
    archive_id: input.archiveId,
    kind: input.kind,
    target: input.target,
    note: input.note ?? null,
    sort_order: (next?.m ?? 0) + 1,
    created_at: now,
    updated_at: now,
  });
  return requireById(getEntry(database, id), '资料入口', id);
}

export function getEntry(database: DatabaseSync, id: string): MaterialEntry | undefined {
  const row = queryOne<EntryRow>(database, `SELECT * FROM ${ENTRIES} WHERE id = ? AND deleted_at IS NULL`, id);
  return row === undefined ? undefined : toEntry(row);
}

/** 一条资料的全部入口，按排序值（= 常用程度）升序 */
export function listEntries(database: DatabaseSync, archiveId: string): MaterialEntry[] {
  const rows = queryAll<EntryRow>(
    database,
    `SELECT * FROM ${ENTRIES} WHERE archive_id = ? AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    archiveId,
  );
  return rows.map(toEntry);
}

/**
 * 全部入口（用于把资料路径写进检索索引）。
 * 需求 F-15 要求能搜到资料的路径与注释，而索引是整表重建式的，
 * 因此这里一次性取全量，由调用方按 archive_id 分组。
 */
export function listAllEntries(database: DatabaseSync): MaterialEntry[] {
  const rows = queryAll<EntryRow>(
    database,
    `SELECT * FROM ${ENTRIES} WHERE deleted_at IS NULL ORDER BY archive_id ASC, sort_order ASC`,
  );
  return rows.map(toEntry);
}

/** 全部挂靠（用于索引重建与自检） */
export function listAllLinks(database: DatabaseSync): MaterialLink[] {
  const rows = queryAll<LinkRow>(
    database,
    `SELECT * FROM ${LINKS} ORDER BY archive_id ASC, target_type ASC`,
  );
  return rows.map(toLink);
}

/** 批量取入口，避免"资料列表里每条都查一次"的 N+1 */
export function listEntriesForArchives(database: DatabaseSync, archiveIds: readonly string[]): Map<string, MaterialEntry[]> {
  const grouped = new Map<string, MaterialEntry[]>();
  if (archiveIds.length === 0) return grouped;

  const placeholders = archiveIds.map(() => '?').join(', ');
  const rows = queryAll<EntryRow>(
    database,
    `SELECT * FROM ${ENTRIES} WHERE archive_id IN (${placeholders}) AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    ...archiveIds,
  );
  for (const row of rows) {
    const entry = toEntry(row);
    const list = grouped.get(entry.archiveId);
    if (list === undefined) grouped.set(entry.archiveId, [entry]);
    else list.push(entry);
  }
  return grouped;
}

export interface EntryPatch {
  kind?: MaterialEntryKind;
  target?: string;
  note?: string | null;
  sortOrder?: number;
}

export function updateEntry(database: DatabaseSync, id: string, patch: EntryPatch): MaterialEntry {
  requireById(getEntry(database, id), '资料入口', id);
  updateById(database, ENTRIES, id, {
    kind: patch.kind,
    target: patch.target,
    note: patch.note,
    sort_order: patch.sortOrder,
  });
  return requireById(getEntry(database, id), '资料入口', id);
}

export function deleteEntry(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, ENTRIES, '资料入口', id);
}

/** 按 id 顺序重排入口：第 n 个的 sort_order = n+1。用于"按常用程度排序" */
export function reorderEntries(database: DatabaseSync, archiveId: string, orderedIds: readonly string[]): void {
  const now = nowIso();
  orderedIds.forEach((id, index) => {
    execute(
      database,
      `UPDATE ${ENTRIES} SET sort_order = ?, updated_at = ? WHERE id = ? AND archive_id = ? AND deleted_at IS NULL`,
      index + 1,
      now,
      id,
      archiveId,
    );
  });
}

export function countEntries(database: DatabaseSync, archiveId: string): number {
  const row = queryOne<{ c: number }>(
    database,
    `SELECT COUNT(*) AS c FROM ${ENTRIES} WHERE archive_id = ? AND deleted_at IS NULL`,
    archiveId,
  );
  return Number(row?.c ?? 0);
}

// ---------- 挂靠 ----------

interface LinkRow {
  archive_id: string;
  target_type: string;
  target_id: string;
  created_at: string;
}

function toLink(row: LinkRow): MaterialLink {
  assertLinkType(row.target_type);
  return {
    archiveId: row.archive_id,
    targetType: row.target_type,
    targetId: row.target_id,
    createdAt: row.created_at,
  };
}

export function linkMaterial(database: DatabaseSync, archiveId: string, targetType: MaterialLinkType, targetId: string): void {
  insert(database, LINKS, {
    archive_id: archiveId,
    target_type: targetType,
    target_id: targetId,
    created_at: nowIso(),
  });
}

/** 幂等挂靠：已存在则什么都不做（避免重复点击报错） */
export function linkMaterialIfAbsent(database: DatabaseSync, archiveId: string, targetType: MaterialLinkType, targetId: string): boolean {
  const existing = queryOne<LinkRow>(
    database,
    `SELECT * FROM ${LINKS} WHERE archive_id = ? AND target_type = ? AND target_id = ?`,
    archiveId,
    targetType,
    targetId,
  );
  if (existing !== undefined) return false;
  linkMaterial(database, archiveId, targetType, targetId);
  return true;
}

export function unlinkMaterial(database: DatabaseSync, archiveId: string, targetType: MaterialLinkType, targetId: string): boolean {
  const result = execute(
    database,
    `DELETE FROM ${LINKS} WHERE archive_id = ? AND target_type = ? AND target_id = ?`,
    archiveId,
    targetType,
    targetId,
  );
  return result.changes > 0;
}

export function listLinks(database: DatabaseSync, archiveId: string): MaterialLink[] {
  const rows = queryAll<LinkRow>(
    database,
    `SELECT * FROM ${LINKS} WHERE archive_id = ? ORDER BY target_type ASC, created_at ASC`,
    archiveId,
  );
  return rows.map(toLink);
}

/** 某个任务/项目上挂着的全部资料 */
export function listArchivesLinkedTo(database: DatabaseSync, targetType: MaterialLinkType, targetId: string): string[] {
  const rows = queryAll<{ archive_id: string }>(
    database,
    `SELECT archive_id FROM ${LINKS} WHERE target_type = ? AND target_id = ?
     ORDER BY created_at DESC`,
    targetType,
    targetId,
  );
  return rows.map((row) => row.archive_id);
}

export function countLinks(database: DatabaseSync, archiveId: string): number {
  const row = queryOne<{ c: number }>(
    database,
    `SELECT COUNT(*) AS c FROM ${LINKS} WHERE archive_id = ?`,
    archiveId,
  );
  return Number(row?.c ?? 0);
}

/**
 * 零挂靠的正式资料（违反 M1）。
 * 供资料页"未挂靠"筛选与完整性自检使用。软删除的资料不算。
 *
 * 关键：**只认指向真实对象的挂靠**。指向已删除任务的挂靠行是孤儿，
 * 它不能算作"这条资料有着落"——否则一条资料会看起来已挂靠，
 * 实际上点进去什么都没有。这也让本函数与 countDanglingLinks 的口径一致。
 */
export function listOrphanArchives(database: DatabaseSync): string[] {
  const rows = queryAll<{ id: string }>(
    database,
    `SELECT a.id FROM archive_items a
     WHERE a.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ${LINKS} l
         WHERE l.archive_id = a.id
           AND (
             (l.target_type = 'task'    AND l.target_id IN (SELECT id FROM tasks)) OR
             (l.target_type = 'project' AND l.target_id IN (SELECT id FROM projects))
           )
       )
     ORDER BY a.created_at DESC`,
  );
  return rows.map((row) => row.id);
}

/** 有效挂靠数（只算指向真实对象的），未挂靠判定与它一致 */
export function countValidLinks(database: DatabaseSync, archiveId: string): number {
  const row = queryOne<{ c: number }>(
    database,
    `SELECT COUNT(*) AS c FROM ${LINKS} l
     WHERE l.archive_id = ?
       AND (
         (l.target_type = 'task'    AND l.target_id IN (SELECT id FROM tasks)) OR
         (l.target_type = 'project' AND l.target_id IN (SELECT id FROM projects))
       )`,
    archiveId,
  );
  return Number(row?.c ?? 0);
}

/**
 * 清理指向已不存在对象的挂靠（孤儿挂靠）。
 * target_id 是多态的，SQLite 给不了外键，所以需要显式清理：
 * 删除任务/项目时调用它，verify 也用它兜底。
 */
export function pruneDanglingLinks(database: DatabaseSync): number {
  const taskResult = execute(
    database,
    `DELETE FROM ${LINKS}
     WHERE target_type = 'task'
       AND target_id NOT IN (SELECT id FROM tasks)`,
  );
  const projectResult = execute(
    database,
    `DELETE FROM ${LINKS}
     WHERE target_type = 'project'
       AND target_id NOT IN (SELECT id FROM projects)`,
  );
  return taskResult.changes + projectResult.changes;
}

/** 统计孤儿挂靠数量（供 verify 报告，不修改数据） */
export function countDanglingLinks(database: DatabaseSync): number {
  const row = queryOne<{ c: number }>(
    database,
    `SELECT
       (SELECT COUNT(*) FROM ${LINKS} WHERE target_type = 'task' AND target_id NOT IN (SELECT id FROM tasks))
     + (SELECT COUNT(*) FROM ${LINKS} WHERE target_type = 'project' AND target_id NOT IN (SELECT id FROM projects)) AS c`,
  );
  return Number(row?.c ?? 0);
}

/** 删除某个对象上的全部挂靠（删除任务/项目时调用） */
export function unlinkAllFor(database: DatabaseSync, targetType: MaterialLinkType, targetId: string): number {
  const result = execute(
    database,
    `DELETE FROM ${LINKS} WHERE target_type = ? AND target_id = ?`,
    targetType,
    targetId,
  );
  return result.changes;
}
