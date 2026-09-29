// 全文检索仓储。
//
// 中文必须折叠成 bigram 再写入 tokens 列（原因见 docs/design.md §6.5）。
// 单字查询无法命中 bigram，退化为 LIKE —— 此时结果集很小，全表扫描可接受。
//
// FTS5 的 rowid 由 (entity_type, entity_id) 稳定推导，因此单条重建 = 删 + 插，
// 不需要额外的映射表（见 docs/design.md 的未决项 D6 说明）。

import type { DatabaseSync } from 'node:sqlite';
import { execute, queryAll, queryOne } from '../db/connection.ts';
import { buildFtsMatch, toTokens } from '../db/tokens.ts';
import { ENTITY_TYPES, enumGuard } from '../domain/types.ts';
import type { EntityType } from '../domain/types.ts';

const FTS_TABLE = 'search_fts';
/** 单次搜索返回上限 */
const DEFAULT_LIMIT = 30;

export interface SearchHit {
  entityType: EntityType;
  entityId: string;
  title: string;
  body: string;
}

export interface IndexInput {
  entityType: EntityType;
  entityId: string;
  title: string;
  body?: string;
}

const assertEntityType = enumGuard(ENTITY_TYPES, '实体类型');

/**
 * (type, id) → FTS rowid。
 * 用 FNV-1a 32 位把字符串压成稳定整数；碰撞概率在万级数据下可忽略，
 * 且碰撞只影响排序（额外命中一条），不会造成数据错误。
 * reindexAll() 提供从零重建的兜底手段。
 */
export function docRowId(entityType: EntityType, entityId: string): number {
  const text = `${entityType}:${entityId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // 收敛到 31 位非负整数：FTS5 不接受负 rowid
  return hash >>> 1;
}

/** 写入或更新一条索引。删除后插入，保证不会出现重复条目。 */
export function indexEntity(database: DatabaseSync, input: IndexInput): void {
  const rowId = docRowId(input.entityType, input.entityId);
  const title = input.title ?? '';
  const body = input.body ?? '';
  execute(database, `DELETE FROM ${FTS_TABLE} WHERE rowid = ?`, rowId);
  execute(
    database,
    `INSERT INTO ${FTS_TABLE} (rowid, doc_id, entity_type, entity_id, title, body, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    rowId,
    `${input.entityType}:${input.entityId}`,
    input.entityType,
    input.entityId,
    title,
    body,
    toTokens(`${title} ${body}`),
  );
}

export function removeEntity(database: DatabaseSync, entityType: EntityType, entityId: string): void {
  execute(database, `DELETE FROM ${FTS_TABLE} WHERE rowid = ?`, docRowId(entityType, entityId));
}

export function countIndexed(database: DatabaseSync): number {
  const row = queryOne<{ c: number }>(database, `SELECT COUNT(*) AS c FROM ${FTS_TABLE}`);
  return Number(row?.c ?? 0);
}

export interface SearchOptions {
  types?: readonly EntityType[];
  limit?: number;
}

interface HitRow {
  entity_type: string;
  entity_id: string;
  title: string | null;
  body: string | null;
}

function toHit(row: HitRow): SearchHit {
  assertEntityType(row.entity_type);
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title ?? '',
    body: row.body ?? '',
  };
}

/**
 * 搜索。命中策略：
 *  1. 能用 bigram 表达式（查询折叠后不是单字）→ 走 FTS5 倒排索引
 *  2. 单字中文查询 → 退化为 LIKE
 * 结果按实体类型优先级稳定排序，不做相关性打分（可预测性优先）。
 */
export function search(database: DatabaseSync, query: string, options: SearchOptions = {}): SearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const types = options.types;
  const typeFilter = types === undefined || types.length === 0 ? '' : ` AND entity_type IN (${types.map(() => '?').join(', ')})`;
  const typeParams: string[] = types === undefined ? [] : [...types];

  const match = buildFtsMatch(trimmed);
  if (match !== null) {
    const rows = queryAll<HitRow>(
      database,
      `SELECT entity_type, entity_id, title, body FROM ${FTS_TABLE}
       WHERE ${FTS_TABLE} MATCH ?${typeFilter}
       LIMIT ?`,
      match,
      ...typeParams,
      limit,
    );
    return rows.map(toHit).sort(byEntityPriority);
  }

  // 退路：单字或无法折叠的查询
  const like = `%${trimmed}%`;
  const rows = queryAll<HitRow>(
    database,
    `SELECT entity_type, entity_id, title, body FROM ${FTS_TABLE}
     WHERE (title LIKE ? OR body LIKE ?)${typeFilter}
     LIMIT ?`,
    like,
    like,
    ...typeParams,
    limit,
  );
  return rows.map(toHit).sort(byEntityPriority);
}

/** 结果排序：任务优先于资料优先于收件箱，便于"先找到要做的事" */
const ENTITY_PRIORITY: Readonly<Record<EntityType, number>> = {
  task: 0,
  subtask: 1,
  project: 2,
  progress: 3,
  archive: 4,
  inbox: 5,
  log: 6,
};

function byEntityPriority(a: SearchHit, b: SearchHit): number {
  const diff = (ENTITY_PRIORITY[a.entityType] ?? 99) - (ENTITY_PRIORITY[b.entityType] ?? 99);
  if (diff !== 0) return diff;
  return a.entityId.localeCompare(b.entityId);
}

/** 清空并重建整个索引。返回索引条数。用于索引损坏或算法变更后的兜底。 */
export function rebuildIndex(
  database: DatabaseSync,
  collect: () => IndexInput[],
): number {
  execute(database, `DELETE FROM ${FTS_TABLE}`);
  const inputs = collect();
  for (const input of inputs) indexEntity(database, input);
  return inputs.length;
}
