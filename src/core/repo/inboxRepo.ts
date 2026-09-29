// 收件箱仓储。收件箱是"一切未分类输入"的落点，独立于 tasks 表：
// 任务必须有项目归属，而捕获时不允许要求分类（见 docs/design.md §4.5）。

import type { DatabaseSync } from 'node:sqlite';
import { execute, queryAll, queryOne } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import { enumGuard, INBOX_KIND_HINTS, INBOX_STATUSES } from '../domain/types.ts';
import type { InboxItem, InboxKindHint, InboxStatus } from '../domain/types.ts';
import { NotFoundError } from '../domain/errors.ts';
import { softDeleteOrThrow } from './helpers.ts';

interface InboxRow {
  id: string;
  body: string;
  kind_hint: string | null;
  status: string;
  parsed_due: string | null;
  raw_input: string | null;
  converted_to: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const assertStatus = enumGuard(INBOX_STATUSES, '收件箱状态');
const assertKindHint = enumGuard(INBOX_KIND_HINTS, '收件箱类型提示');

function toItem(row: InboxRow): InboxItem {
  assertStatus(row.status);
  if (row.kind_hint !== null) assertKindHint(row.kind_hint);
  return {
    id: row.id,
    body: row.body,
    kindHint: row.kind_hint,
    status: row.status,
    parsedDue: row.parsed_due,
    rawInput: row.raw_input,
    convertedTo: row.converted_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface CreateInboxInput {
  /** 用户输入的原文 */
  body: string;
  /** 解析出的截止日键，仅作提示，不构成任务字段 */
  parsedDue?: string | null;
  kindHint?: InboxKindHint | null;
  /** 解析前的原始文本；与 body 不同时才需要传 */
  rawInput?: string | null;
}

export function createInboxItem(database: DatabaseSync, input: CreateInboxInput): InboxItem {
  const id = newId();
  const now = nowIso();
  execute(
    database,
    `INSERT INTO inbox_items (id, body, kind_hint, status, parsed_due, raw_input, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    id,
    input.body,
    input.kindHint ?? null,
    input.parsedDue ?? null,
    input.rawInput ?? null,
    now,
    now,
  );
  const created = getInboxItem(database, id);
  if (created === undefined) throw new NotFoundError(`收件箱条目创建后立即读取失败：${id}`);
  return created;
}

export function getInboxItem(database: DatabaseSync, id: string): InboxItem | undefined {
  const row = queryOne<InboxRow>(
    database,
    'SELECT * FROM inbox_items WHERE id = ? AND deleted_at IS NULL',
    id,
  );
  return row === undefined ? undefined : toItem(row);
}

/**
 * 按创建时间倒序列出待处理条目（最新的在最前）。
 * rowid 作为次级排序键：同一毫秒内记入多条时 created_at 相同，
 * 只按时间排序会得到不稳定的顺序，而快记列表的顺序必须可预期。
 */
export function listPendingInbox(database: DatabaseSync, limit = 50): InboxItem[] {
  const rows = queryAll<InboxRow>(
    database,
    `SELECT * FROM inbox_items
     WHERE status = 'pending' AND deleted_at IS NULL
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
    limit,
  );
  return rows.map(toItem);
}

export function countPendingInbox(database: DatabaseSync): number {
  const row = queryOne<{ c: number }>(
    database,
    `SELECT COUNT(*) AS c FROM inbox_items WHERE status = 'pending' AND deleted_at IS NULL`,
  );
  return Number(row?.c ?? 0);
}

/** 在时间区间内创建的收件箱条目（每日日志汇总用） */
export function listInboxCreatedBetween(database: DatabaseSync, startIso: string, endIso: string): InboxItem[] {
  const rows = queryAll<InboxRow>(
    database,
    `SELECT * FROM inbox_items WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
    startIso,
    endIso,
  );
  return rows.map(toItem);
}

/**
 * 标记为已分类。
 * convertedTo 记录去向（如 'task:<id>'），用于回溯这条碎片变成了什么。
 */
export function markConverted(database: DatabaseSync, id: string, convertedTo: string): InboxItem {
  const changed = execute(
    database,
    `UPDATE inbox_items SET status = 'converted', converted_to = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    convertedTo,
    nowIso(),
    id,
  );
  if (changed.changes === 0) throw new NotFoundError(`收件箱条目不存在：${id}`);
  const updated = getInboxItem(database, id);
  if (updated === undefined) throw new NotFoundError(`收件箱条目不存在：${id}`);
  return updated;
}

/** 丢弃：判定为垃圾，无需转成任何对象 */
export function archiveInboxItem(database: DatabaseSync, id: string): void {
  const changed = execute(
    database,
    `UPDATE inbox_items SET status = 'archived', updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    nowIso(),
    id,
  );
  if (changed.changes === 0) throw new NotFoundError(`收件箱条目不存在：${id}`);
}

/** 软删除：仅在纠正误录时使用；常规清空应走"丢弃"（archived） */
export function deleteInboxItem(database: DatabaseSync, id: string): void {
  softDeleteOrThrow(database, 'inbox_items', '收件箱条目', id);
}
