// ID 前缀解析：命令行里没人愿意敲完整 UUID。
// 与 git 短哈希同理：接受唯一前缀，歧义时报错并列出候选，而不是猜一个。

import type { DatabaseSync } from 'node:sqlite';
import { queryAll } from '../core/db/connection.ts';
import { ENTITY_TYPES, enumGuard } from '../core/domain/types.ts';
import type { EntityType } from '../core/domain/types.ts';
import { NotFoundError, ValidationError } from '../core/domain/errors.ts';

/** 实体类型 → 实表与用于展示的标题列 */
const TABLE_OF: Readonly<Record<EntityType, { table: string; titleColumn: string }>> = {
  project: { table: 'projects', titleColumn: 'title' },
  task: { table: 'tasks', titleColumn: 'title' },
  subtask: { table: 'subtasks', titleColumn: 'title' },
  progress: { table: 'progress_entries', titleColumn: 'body' },
  inbox: { table: 'inbox_items', titleColumn: 'body' },
  archive: { table: 'archive_items', titleColumn: 'COALESCE(title, body)' },
  log: { table: 'daily_logs', titleColumn: 'day_key' },
};

const assertEntityType = enumGuard(ENTITY_TYPES, '实体类型');

/** 最短可接受前缀长度：太短会频繁歧义，1 位等于猜 */
export const MIN_PREFIX_LENGTH = 4;

export interface ResolvedRef {
  id: string;
  title: string;
}

/**
 * 把前缀解析成唯一 ID。
 * 只在未删除的记录里找；歧义时抛出带候选列表的错误，由命令行展示。
 */
export function resolveRef(database: DatabaseSync, entityType: EntityType, prefix: string): ResolvedRef {
  assertEntityType(entityType);
  const spec = TABLE_OF[entityType];
  const trimmed = prefix.trim();

  if (trimmed.length === 0) throw new ValidationError('ID 前缀不能为空');

  // 完整 ID 直接命中，无需模糊匹配
  const exact = database
    .prepare(`SELECT id, ${spec.titleColumn} AS title FROM ${spec.table} WHERE id = ?`)
    .get(trimmed) as { id: string; title: string | null } | undefined;
  if (exact !== undefined) {
    return { id: exact.id, title: exact.title ?? '' };
  }

  if (trimmed.length < MIN_PREFIX_LENGTH) {
    throw new ValidationError(`ID 前缀至少需要 ${MIN_PREFIX_LENGTH} 位，收到「${trimmed}」`);
  }

  const candidates = queryAll<{ id: string; title: string | null }>(
    database,
    `SELECT id, ${spec.titleColumn} AS title FROM ${spec.table}
     WHERE id LIKE ? AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 10`,
    `${trimmed}%`,
  );

  if (candidates.length === 0) {
    throw new NotFoundError(`找不到匹配「${trimmed}」的${labelOf(entityType)}`);
  }
  if (candidates.length > 1) {
    const list = candidates.map((row) => `  ${row.id.slice(0, 8)}  ${row.title ?? ''}`).join('\n');
    throw new ValidationError(`前缀「${trimmed}」匹配到 ${candidates.length} 条，请多给几位：\n${list}`);
  }

  const only = candidates[0];
  if (only === undefined) throw new NotFoundError(`找不到匹配「${trimmed}」的${labelOf(entityType)}`);
  return { id: only.id, title: only.title ?? '' };
}

const LABELS: Readonly<Record<EntityType, string>> = {
  project: '项目',
  task: '任务',
  subtask: '子任务',
  progress: '进展记录',
  inbox: '收件箱条目',
  archive: '资料条目',
  log: '日志',
};

function labelOf(entityType: EntityType): string {
  return LABELS[entityType];
}
