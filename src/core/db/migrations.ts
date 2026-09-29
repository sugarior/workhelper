// 迁移执行器：按文件名序号顺序应用，只前进不后退。
// 版本号存在 SQLite 的 `PRAGMA user_version` 里，不额外建版本表。
// 回滚策略是备份恢复，因此每个迁移只写 up，不写 down（见 docs/design.md §2.2）。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pragmaValue, SCHEMA_VERSION } from './connection.ts';
import { withTx } from './tx.ts';
import { MigrationError } from '../domain/errors.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const FILENAME_PATTERN = /^(\d{3})_[\w-]+\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly path: string;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

function readVersion(database: DatabaseSync): number {
  return pragmaValue<{ user_version: number }>(database, 'user_version')?.user_version ?? 0;
}

/** 列出可用迁移，按版本升序。文件名不合规直接报错，避免静默漏跑。 */
export function listMigrations(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const matched = FILENAME_PATTERN.exec(entry.name);
    if (matched?.[1] === undefined) {
      throw new MigrationError(`迁移文件名不符合 NNN_描述.sql 规范：${entry.name}`);
    }
    files.push({
      version: Number(matched[1]),
      name: entry.name,
      path: join(MIGRATIONS_DIR, entry.name),
    });
  }

  files.sort((a, b) => a.version - b.version);
  for (let i = 0; i < files.length; i += 1) {
    if (files[i]?.version !== i + 1) {
      throw new MigrationError(`迁移序号必须从 001 连续递增，在 ${files[i]?.name} 处中断`);
    }
  }
  return files;
}

export function currentVersion(database: DatabaseSync): number {
  return readVersion(database);
}

/** 迁移文件数量必须与代码声明的期望版本一致，否则视为代码未同步更新。 */
export function assertSchemaVersionInSync(files: readonly MigrationFile[] = listMigrations()): number {
  if (files.length !== SCHEMA_VERSION) {
    throw new MigrationError(
      `迁移文件有 ${files.length} 个，但 SCHEMA_VERSION 声明为 ${SCHEMA_VERSION}：` +
        '新增迁移后必须同步更新 connection.ts 里的 SCHEMA_VERSION',
    );
  }
  return SCHEMA_VERSION;
}

/** 把数据库结构升到最新版；已是最新则不做任何事（幂等）。 */
export function migrate(database: DatabaseSync, target?: number): MigrationResult {
  const files = listMigrations();
  assertSchemaVersionInSync(files);
  const from = readVersion(database);
  const latest = target ?? SCHEMA_VERSION;

  if (from > latest) {
    throw new MigrationError(`数据库结构版本为 ${from}，高于代码支持的 ${latest}：请升级程序而非降级数据库`);
  }
  if (from === latest) {
    return { from, to: from, applied: [] };
  }

  const applied: string[] = [];
  for (const file of files) {
    if (file.version <= from || file.version > latest) continue;
    const sql = readFileSync(file.path, 'utf8');
    // 整个迁移（建表 + 版本号）在一个事务内，中途失败不留半成品结构
    withTx(database, () => {
      database.exec(sql);
      // user_version 不接受参数绑定，此处版本号来自经过校验的文件名，无注入风险
      database.exec(`PRAGMA user_version = ${file.version}`);
    });
    applied.push(file.name);
  }

  return { from, to: latest, applied };
}
