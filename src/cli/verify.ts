// 数据自检。
//
// 分两层：
//  1. SQLite 层：integrity_check 与 foreign_key_check，失败就是硬故障
//  2. 业务层：状态与字段是否自相矛盾（阻塞无原因、完成无时间、孤儿进展、索引滞后）
//
// 业务层问题默认只报告不失败——它们是"数据不干净"，不是"数据损坏"。
// 加 --strict 可以让它们也导致非零退出码，便于脚本化巡检。

import type { DatabaseSync } from 'node:sqlite';
import type { SystemService } from '../core/service/index.ts';

export interface VerifyContext {
  database: DatabaseSync;
  json: boolean;
  services: { system: SystemService };
}

interface VerifyReport {
  ok: boolean;
  sqliteIntegrity: string;
  foreignKeyOrphans: number;
  issues: string[];
  indexCount: number;
  liveEntityCount: number;
  trashCount: number;
}

/** 统计"应当被索引"的实体数量，用于发现索引明显滞后 */
function countLiveEntities(database: DatabaseSync): number {
  const tables = [
    'projects',
    'tasks',
    'subtasks',
    'progress_entries',
    'inbox_items',
    'archive_items',
    'daily_logs',
  ];
  let total = 0;
  for (const table of tables) {
    const row = database
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE deleted_at IS NULL`)
      .get() as { c: number } | undefined;
    total += Number(row?.c ?? 0);
  }
  return total;
}

export function verifyData(database: DatabaseSync, system: SystemService): VerifyReport {
  const base = system.integrityCheck();
  const indexCount = (
    database.prepare('SELECT COUNT(*) AS c FROM search_fts').get() as { c: number } | undefined
  )?.c ?? 0;
  const liveEntityCount = countLiveEntities(database);
  const issues = [...base.issues];

  // 索引可能合法地少于实体数（例如进展记录在设计上都会入索引，但历史数据可能没入）。
  // 这里只提示明显异常，不当作故障。
  if (Number(indexCount) === 0 && liveEntityCount > 0) {
    issues.push(`检索索引为空，但有 ${liveEntityCount} 条记录；可运行 reindex 重建`);
  }

  return {
    ok: base.ok,
    sqliteIntegrity: base.sqliteIntegrity,
    foreignKeyOrphans: base.foreignKeyOrphans,
    issues,
    indexCount: Number(indexCount),
    liveEntityCount,
    trashCount: system.trash.count(),
  };
}

export function runVerify(context: VerifyContext): void {
  const report = verifyData(context.database, context.services.system);
  const strict = process.argv.includes('--strict');
  const failed = !report.ok || (strict && report.issues.length > 0);

  if (context.json) {
    console.log(JSON.stringify({ ...report, strict }, null, 2));
    if (failed) process.exitCode = 1;
    return;
  }

  console.log(`SQLite 完整性 : ${report.sqliteIntegrity}`);
  console.log(`外键孤儿      : ${report.foreignKeyOrphans} 条`);
  console.log(`检索索引      : ${report.indexCount} 条（存活记录 ${report.liveEntityCount} 条）`);
  console.log(`回收站        : ${report.trashCount} 条`);

  if (report.issues.length === 0) {
    console.log('\n业务自检      : 通过，未发现矛盾数据');
  } else {
    console.log(`\n业务自检      : 发现 ${report.issues.length} 项问题`);
    for (const issue of report.issues) console.log(`  · ${issue}`);
    if (strict) console.log('\n（--strict 模式下这些问题会导致退出码非零）');
    else console.log('\n提示：这些是数据不干净，不是数据损坏。加 --strict 可让它们影响退出码。');
  }

  if (failed) process.exitCode = 1;
}
