// 每日日志仓储：一天一条，正文由我手写。
// 自动汇总部分**不落库**——它是运行时投影。若写入正文，
// 任务状态一变历史日志就会变成错的（见 docs/design.md §6.4）。

import type { DatabaseSync } from 'node:sqlite';
import { insert, queryAll, queryOne, updateById } from '../db/connection.ts';
import { newId, nowIso } from '../domain/clock.ts';
import type { DailyLog } from '../domain/types.ts';
import { requireById, softDeleteOrThrow } from './helpers.ts';

const TABLE = 'daily_logs';

interface DailyLogRow {
  id: string;
  day_key: string;
  body: string | null;
  mood: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toLog(row: DailyLogRow): DailyLog {
  return {
    id: row.id,
    dayKey: row.day_key,
    body: row.body,
    mood: row.mood,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function getDailyLog(database: DatabaseSync, dayKey: string): DailyLog | undefined {
  const row = queryOne<DailyLogRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE day_key = ? AND deleted_at IS NULL`,
    dayKey,
  );
  return row === undefined ? undefined : toLog(row);
}

/** 保存正文：不存在则创建，存在则更新（一天一条由 UNIQUE 约束保证） */
export function saveDailyLog(database: DatabaseSync, dayKey: string, body: string): DailyLog {
  const existing = getDailyLog(database, dayKey);
  if (existing !== undefined) {
    updateById(database, TABLE, existing.id, { body });
    return requireById(getDailyLog(database, dayKey), '每日日志', dayKey);
  }

  const id = newId();
  const now = nowIso();
  insert(database, TABLE, {
    id,
    day_key: dayKey,
    body,
    created_at: now,
    updated_at: now,
  });
  return requireById(getDailyLog(database, dayKey), '每日日志', dayKey);
}

export interface DailyLogFilter {
  /** 起始日键（含） */
  from?: string;
  /** 结束日键（含） */
  to?: string;
  limit?: number;
}

export function listDailyLogs(database: DatabaseSync, filter: DailyLogFilter = {}): DailyLog[] {
  const conditions = ['deleted_at IS NULL'];
  const params: (string | number | null)[] = [];
  if (filter.from !== undefined) {
    conditions.push('day_key >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push('day_key <= ?');
    params.push(filter.to);
  }
  const rows = queryAll<DailyLogRow>(
    database,
    `SELECT * FROM ${TABLE} WHERE ${conditions.join(' AND ')} ORDER BY day_key DESC LIMIT ?`,
    ...params,
    filter.limit ?? 100,
  );
  return rows.map(toLog);
}

export function deleteDailyLog(database: DatabaseSync, dayKey: string): void {
  const existing = requireById(getDailyLog(database, dayKey), '每日日志', dayKey);
  softDeleteOrThrow(database, TABLE, '每日日志', existing.id);
}
