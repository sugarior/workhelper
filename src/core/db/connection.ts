// 数据库连接与查询基座。这是唯一创建 DatabaseSync 的地方。
// 与 docs/design.md §2.2 分层纪律对应：SQL 语句只出现在 db/ 与 repo/。
//
// 这里提供的是"薄"辅助：只负责参数绑定、行形状断言、动态 UPDATE 拼接，
// 不含任何业务含义。业务语义一律留给 repo/ 与 service/。

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConstraintError } from '../domain/errors.ts';

/** 代码期望的结构版本 = 最新迁移序号。新增迁移文件后需同步这里。 */
export const SCHEMA_VERSION = 5;

export const DEFAULT_DB_FILENAME = 'workhelper.db';

export type SqlParam = string | number | bigint | null | Uint8Array;

interface StatementResult {
  changes: number;
  lastInsertRowid: number;
}

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
  // WAL 下 NORMAL 仍保证已提交事务不因断电丢失，只在极端断电时可能丢最后若干事务
  database.exec('PRAGMA synchronous = NORMAL;');
  return database;
}

export function closeDatabase(database: DatabaseSync): void {
  database.close();
}

/** 读取单行。node:sqlite 返回 unknown，形状由调用方以行类型断言。 */
export function queryOne<TRow>(database: DatabaseSync, sql: string, ...params: SqlParam[]): TRow | undefined {
  return database.prepare(sql).get(...params) as TRow | undefined;
}

/** 读取多行 */
export function queryAll<TRow>(database: DatabaseSync, sql: string, ...params: SqlParam[]): TRow[] {
  return database.prepare(sql).all(...params) as TRow[];
}

/** 执行写语句 */
export function execute(database: DatabaseSync, sql: string, ...params: SqlParam[]): StatementResult {
  const result = database.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

/** 读取单值 PRAGMA（如 journal_mode、user_version） */
export function pragmaValue<TRow>(database: DatabaseSync, pragma: string): TRow | undefined {
  return database.prepare(`PRAGMA ${pragma}`).get() as TRow | undefined;
}

/**
 * 插入一行。列名与值必须一一对应，全部走参数绑定。
 * 列名来自调用方的字面量，不接受外部输入。
 */
export function insert(
  database: DatabaseSync,
  table: string,
  values: Readonly<Record<string, SqlParam>>,
): StatementResult {
  const columns = Object.keys(values);
  if (columns.length === 0) throw new Error(`insert(${table}) 未提供任何列`);
  const placeholders = columns.map(() => '?').join(', ');
  const params = columns.map((column) => values[column] ?? null);
  return execute(database, `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, ...params);
}

/**
 * 按主键部分更新。只更新 patch 中出现的列，并自动维护 updated_at。
 *
 * 动态列名来自代码字面量，但仍用表的真实列清单校验一次：
 * 一旦有人把外部输入拼进列名，会在这里直接失败而不是形成注入面。
 */
export function updateById(
  database: DatabaseSync,
  table: string,
  id: string,
  patch: Readonly<Record<string, SqlParam>>,
  options: { touchUpdatedAt?: boolean } = {},
): StatementResult {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return { changes: 0, lastInsertRowid: 0 };

  const allowed = tableColumns(database, table);
  const assignments: string[] = [];
  const params: SqlParam[] = [];
  for (const [column, value] of entries) {
    if (!allowed.has(column)) {
      throw new Error(`updateById(${table}) 收到未知列：${column}`);
    }
    assignments.push(`${column} = ?`);
    params.push(value ?? null);
  }
  if (options.touchUpdatedAt !== false) {
    assignments.push('updated_at = ?');
    params.push(new Date().toISOString());
  }
  params.push(id);

  return execute(database, `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`, ...params);
}

/**
 * 软删除：打时间戳，不做物理删除（回收站与恢复依赖它）。
 * updated_at 只在表确实有该列时才写——attachments 就没有这一列，
 * 早期版本硬写该列导致运行期报 "no such column"。
 */
export function softDeleteById(database: DatabaseSync, table: string, id: string): StatementResult {
  const now = new Date().toISOString();
  const assignments = ['deleted_at = ?'];
  const params: SqlParam[] = [now];
  if (tableColumns(database, table).has('updated_at')) {
    assignments.push('updated_at = ?');
    params.push(now);
  }
  params.push(id);
  return execute(database, `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ? AND deleted_at IS NULL`, ...params);
}

/** 读取表的所有列名，用于校验动态列名 */
export function tableColumns(database: DatabaseSync, table: string): ReadonlySet<string> {
  const rows = queryAll<{ name: string }>(database, `PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

/**
 * 把 node:sqlite 的约束错误翻译成领域错误。
 * 用于把"数据库拒绝了这次写入"转成能直接展示给用户的话。
 */
export function translateConstraintError(error: unknown, message: string): never {
  if (isSqliteError(error)) {
    const text = `${error.message} ${error.errstr ?? ''}`;
    if (/UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed/i.test(text)) {
      throw new ConstraintError(`${message}（${error.message}）`);
    }
  }
  throw error;
}

function isSqliteError(error: unknown): error is Error & { errcode?: number; errstr?: string } {
  return error instanceof Error && typeof (error as { errcode?: unknown }).errcode === 'number';
}
