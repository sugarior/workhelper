#!/usr/bin/env node
// 命令行入口。M0 阶段先只提供骨架能力（版本、迁移、数据自检），
// 业务命令在 T7 接入（capture / inbox / today / log）。

import { parseArgs } from 'node:util';
import { openDatabase, closeDatabase, DEFAULT_DB_FILENAME } from '../core/db/connection.ts';
import { migrate, currentVersion, listMigrations } from '../core/db/migrations.ts';
import { isDomainError } from '../core/domain/errors.ts';

const VERSION = '0.1.0';

const HELP = `WorkHelper ${VERSION} —— 常驻桌面的个人工作秘书

用法：node src/cli/wh.ts <命令> [选项]

命令：
  --version              显示版本
  migrate                把数据库结构升到最新版（幂等）
  status                 显示数据库与迁移状态
  verify                 数据完整性自检
  help                   显示本帮助

全局选项：
  --db <路径>            指定数据库文件，默认 data/${DEFAULT_DB_FILENAME}
`;

interface CliContext {
  dbPath: string;
}

function resolveContext(values: Record<string, unknown>): CliContext {
  const dbPath = typeof values.db === 'string' ? values.db : `data/${DEFAULT_DB_FILENAME}`;
  return { dbPath };
}

function commandMigrate(context: CliContext): void {
  const database = openDatabase(context.dbPath);
  try {
    const result = migrate(database);
    if (result.applied.length === 0) {
      console.log(`结构已是最新（v${result.to}），无需迁移`);
      return;
    }
    console.log(`结构从 v${result.from} 升级到 v${result.to}`);
    for (const name of result.applied) console.log(`  已应用 ${name}`);
  } finally {
    closeDatabase(database);
  }
}

function commandStatus(context: CliContext): void {
  const database = openDatabase(context.dbPath);
  try {
    const version = currentVersion(database);
    console.log(`数据库    : ${context.dbPath}`);
    console.log(`结构版本  : v${version}`);
    console.log(`可用迁移  : ${listMigrations().length} 个`);
    const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
    console.log(`日志模式  : ${journal?.journal_mode ?? '未知'}`);
    console.log(`外键约束  : ${Number(foreignKeys?.foreign_keys) === 1 ? '已开启' : '未开启'}`);
    if (version < listMigrations().length) {
      console.log('提示      : 结构落后于代码，请运行 migrate');
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(database);
  }
}

function commandVerify(context: CliContext): void {
  const database = openDatabase(context.dbPath);
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    const foreignKeyIssues = database.prepare('PRAGMA foreign_key_check').all() as unknown[];
    const ok = integrity?.integrity_check === 'ok' && foreignKeyIssues.length === 0;
    console.log(`完整性检查: ${integrity?.integrity_check ?? '无结果'}`);
    console.log(`外键孤儿  : ${foreignKeyIssues.length} 条`);
    if (!ok) process.exitCode = 1;
  } finally {
    closeDatabase(database);
  }
}

function main(): void {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: 'boolean' },
      db: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  const values = parsed.values as Record<string, unknown>;
  const context = resolveContext(values);

  if (values.version === true) {
    console.log(VERSION);
    return;
  }

  const command = parsed.positionals[0] ?? (values.help === true ? 'help' : 'help');
  switch (command) {
    case 'migrate':
      commandMigrate(context);
      return;
    case 'status':
      commandStatus(context);
      return;
    case 'verify':
      commandVerify(context);
      return;
    case 'help':
      console.log(HELP);
      return;
    default:
      console.error(`未知命令：${command}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  if (isDomainError(error)) {
    console.error(`[${error.code}] ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
