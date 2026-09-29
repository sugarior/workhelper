// 设置仓储：键值对，值统一 JSON 编码。
// 每个设置项提供一个带默认值的读取函数，调用方不需要关心 JSON 编解码。

import type { DatabaseSync } from 'node:sqlite';
import { insert, queryOne, execute } from '../db/connection.ts';
import { nowIso } from '../domain/clock.ts';
import { assertBoundaryHour } from '../domain/rules.ts';
import { ValidationError } from '../domain/errors.ts';

const TABLE = 'settings';

/** 设置键常量。集中定义避免各处以字符串字面量读写而拼错。 */
export const SETTING_KEYS = {
  dayBoundaryHour: 'day.boundaryHour',
  aiProvider: 'ai.provider',
  aiBaseUrl: 'ai.baseUrl',
  aiModel: 'ai.model',
  lastClassification: 'capture.lastClassification',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

function readRaw(database: DatabaseSync, key: string): string | undefined {
  const row = queryOne<{ value: string }>(database, `SELECT value FROM ${TABLE} WHERE key = ?`, key);
  return row?.value;
}

function writeRaw(database: DatabaseSync, key: string, value: string): void {
  const now = nowIso();
  execute(
    database,
    `INSERT INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now,
  );
}

/** 读取任意 JSON 值；缺失或解析失败时返回 fallback，不让坏数据阻断启动 */
export function getSetting<T>(database: DatabaseSync, key: string, fallback: T): T {
  const raw = readRaw(database, key);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(database: DatabaseSync, key: string, value: unknown): void {
  writeRaw(database, key, JSON.stringify(value));
}

export function deleteSetting(database: DatabaseSync, key: string): void {
  execute(database, `DELETE FROM ${TABLE} WHERE key = ?`, key);
}

export function listSettings(database: DatabaseSync): { key: string; value: unknown; updatedAt: string }[] {
  const rows = database
    .prepare(`SELECT key, value, updated_at FROM ${TABLE} ORDER BY key ASC`)
    .all() as { key: string; value: string; updated_at: string }[];
  return rows.map((row) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    return { key: row.key, value: parsed, updatedAt: row.updated_at };
  });
}

/** 日界小时（默认 4 点）。写入前校验范围。 */
export function getDayBoundaryHour(database: DatabaseSync): number {
  const value = getSetting<number>(database, SETTING_KEYS.dayBoundaryHour, 4);
  if (!Number.isInteger(value) || value < 0 || value > 23) return 4;
  return value;
}

export function setDayBoundaryHour(database: DatabaseSync, hour: number): void {
  try {
    assertBoundaryHour(hour);
  } catch (error) {
    throw error instanceof ValidationError ? error : new ValidationError(String(error));
  }
  setSetting(database, SETTING_KEYS.dayBoundaryHour, hour);
}

/** 原子地写入一条完整设置（供需要"先建后写"的场景使用） */
export function ensureSetting(database: DatabaseSync, key: string, value: unknown): void {
  if (readRaw(database, key) === undefined) {
    const now = nowIso();
    insert(database, TABLE, { key, value: JSON.stringify(value), updated_at: now });
  }
}
