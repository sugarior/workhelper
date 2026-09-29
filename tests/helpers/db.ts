// 测试夹具：内存库 + 已建表，外加常用构造器。
// 所有仓储/服务测试都从这里起步，避免每个测试重复建库。

import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, closeDatabase } from '../../src/core/db/connection.ts';
import { migrate } from '../../src/core/db/migrations.ts';
import { setDayBoundaryHour } from '../../src/core/repo/settingsRepo.ts';
import { todayKey } from '../../src/core/day/dayKey.ts';

/** 建一个空的、结构最新的内存库 */
export function makeDb(): DatabaseSync {
  const database = openDatabase(':memory:');
  migrate(database);
  return database;
}

/** 用完即关，配合 try/finally 使用 */
export function useDb<T>(fn: (database: DatabaseSync) => T): T {
  const database = makeDb();
  try {
    return fn(database);
  } finally {
    closeDatabase(database);
  }
}

/**
 * 把日界设为 0 点（自然日），让"今天"等于日历日期。
 * 默认日界是凌晨 4 点，因此下午跑测试时 todayKey 与 new Date() 的日期
 * 可能相差一天——测试里要断言"今天"就必须先去掉这层歧义。
 */
export function useDbWithCalendarDay<T>(fn: (database: DatabaseSync) => T): T {
  return useDb((database) => {
    setDayBoundaryHour(database, 0);
    return fn(database);
  });
}

/** 当前日键（按数据库里已配置的日界）。测试不要硬编码日期。 */
export function dayKeyNow(database: DatabaseSync): string {
  return todayKey(currentBoundaryHour(database), new Date());
}

function currentBoundaryHour(database: DatabaseSync): number {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'day.boundaryHour'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) return 4;
  const parsed = Number(JSON.parse(row.value));
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 4;
}

/** 固定的基准时间，避免测试依赖真实时钟 */
export const FIXED_NOW = '2026-09-30T02:00:00.000Z';
