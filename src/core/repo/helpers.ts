// 仓储层共用辅助。仓储只做数据存取，不写业务规则：
// 状态机、必填校验、聚合口径都归 service/ 负责。

import type { DatabaseSync } from 'node:sqlite';
import { execute, softDeleteById } from '../db/connection.ts';
import { NotFoundError } from '../domain/errors.ts';

/** 读取一条不存在的记录时统一报这个错，避免各处措辞不一 */
export function requireById<T>(entity: T | undefined, label: string, id: string): T {
  if (entity === undefined) throw new NotFoundError(`${label}不存在：${id}`);
  return entity;
}

/** 软删除，并确认确实删到了一行 */
export function softDeleteOrThrow(database: DatabaseSync, table: string, label: string, id: string): void {
  const result = softDeleteById(database, table, id);
  if (result.changes === 0) throw new NotFoundError(`${label}不存在或已删除：${id}`);
}

/** 同表内取下一个排序值（排在末尾）。返回相邻值 +1，留出插空余量。 */
export function nextSortOrder(database: DatabaseSync, table: string, scopeColumn?: string, scopeValue?: string): number {
  const where = scopeColumn === undefined ? '' : ` AND ${scopeColumn} = ?`;
  const params = scopeColumn === undefined ? [] : [scopeValue ?? ''];
  const row = database
    .prepare(`SELECT MAX(sort_order) AS m FROM ${table} WHERE deleted_at IS NULL${where}`)
    .get(...params) as { m: number | null } | undefined;
  const max = row?.m;
  return max === null || max === undefined ? 1 : Number(max) + 1;
}

/**
 * 拖拽排序：把 movedId 插到 beforeId 之前（beforeId 为空表示移到末尾）。
 * 取相邻两项的中间值，避免重排整列——这是 sort_order 用 REAL 的原因。
 */
export function reorderWithin(
  database: DatabaseSync,
  table: string,
  movedId: string,
  beforeId: string | null,
  scope?: { column: string; value: string },
): number {
  const scopeWhere = scope === undefined ? '' : ` AND ${scope.column} = ?`;
  const scopeParams = scope === undefined ? [] : [scope.value];

  const rows = database
    .prepare(
      `SELECT id, sort_order FROM ${table}
       WHERE deleted_at IS NULL${scopeWhere}
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .all(...scopeParams) as { id: string; sort_order: number }[];

  const remaining = rows.filter((row) => row.id !== movedId);
  const insertIndex = beforeId === null ? remaining.length : remaining.findIndex((row) => row.id === beforeId);
  if (beforeId !== null && insertIndex === -1) {
    throw new NotFoundError(`${table} 中找不到排序参照项：${beforeId}`);
  }

  const previous = insertIndex === 0 ? undefined : remaining[insertIndex - 1];
  const next = remaining[insertIndex];
  let order: number;
  if (previous === undefined && next === undefined) {
    order = 1;
  } else if (previous === undefined) {
    order = Number(next?.sort_order ?? 1) - 1;
  } else if (next === undefined) {
    order = Number(previous.sort_order) + 1;
  } else {
    order = (Number(previous.sort_order) + Number(next.sort_order)) / 2;
  }

  execute(database, `UPDATE ${table} SET sort_order = ?, updated_at = ? WHERE id = ?`, order, new Date().toISOString(), movedId);
  return order;
}
