// 数据库连接与全局 PRAGMA。这是唯一创建 DatabaseSync 的地方。
// 与 docs/design.md §2.2 分层纪律对应：SQL 只出现在 db/ 与 repo/。

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 代码期望的结构版本 = 最新迁移序号。新增迁移文件后需同步这里。 */
export const SCHEMA_VERSION = 1;

export const DEFAULT_DB_FILENAME = 'workhelper.db';

/**
 * 打开数据库并应用运行期 PRAGMA。
 * foreign_keys 必须在每次连接时开启（SQLite 默认关闭，且不随文件持久化）。
 * journal_mode = WAL 是持久设置，重复设置是幂等的。
 */
export function openDatabase(location: string): DatabaseSync {
  if (location !== ':memory:') {
    mkdirSync(dirname(resolve(location)), { recursive: true });
  }

  const database = new DatabaseSync(location);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA busy_timeout = 5000;');
  // WAL 下 NORMAL 仍保证已提交事务不因断电丢失，只在极端断电时可能丢最后若干事务的持久性
  database.exec('PRAGMA synchronous = NORMAL;');
  return database;
}

export function closeDatabase(database: DatabaseSync): void {
  database.close();
}

/** 读取单行并断言为具体行类型：node:sqlite 返回 unknown，由调用方负责形状正确。 */
export function queryOne<T>(database: DatabaseSync, sql: string, ...params: (string | number | null)[]): T | undefined {
  return database.prepare(sql).get(...params) as T | undefined;
}

/** 读取多行 */
export function queryAll<T>(database: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] {
  return database.prepare(sql).all(...params) as T[];
}

/** 执行写语句，返回受影响行数与自增 rowid */
export function execute(
  database: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): { changes: number; lastInsertRowid: number } {
  const result = database.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}
