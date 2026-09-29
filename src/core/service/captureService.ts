// 捕获服务：把"混乱输入"变成结构的第一步。
//
// 设计约束（需求 §6.3）：快记通路不得失败。全程同步、单事务、无网络，
// 日期解析失败只会降级为"原样存标题"，绝不阻断保存。

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  archiveInboxItem, countPendingInbox, createArchive, createInboxItem, createTask,
  deleteArchive, deleteTask, getInboxItem, indexEntity, listPendingInbox, markConverted,
  getDayBoundaryHour, getSetting, setSetting,
} from '../repo/index.ts';
import { parseDate, stripParsedDate } from '../day/parseDate.ts';
import { dayKeyFromIso, nowIso } from '../domain/clock.ts';
import { todayKey } from '../day/dayKey.ts';
import { InvalidTransitionError } from '../domain/errors.ts';
import type { ArchiveKind, EntityType, InboxItem, InboxKindHint, Task } from '../domain/types.ts';
import type { ParsedDate } from '../day/parseDate.ts';

/** 分类目标：把一条收件箱碎片变成什么 */
export type ClassifyTarget =
  | { kind: 'task'; projectId?: string | null; dueDate?: string | null; priority?: Task['priority'] }
  | { kind: 'archive'; archiveKind?: ArchiveKind }
  | { kind: 'discard' };

export interface ClassifyResult {
  inboxId: string;
  /** 生成的实体类型；discard 时为 'inbox'（只是被丢弃） */
  createdKind: EntityType;
  createdId: string;
}

/** 撤销日志：一次分类操作的全部影响，存在 settings 里，避免为此加表 */
interface UndoRecord {
  at: string;
  /** 本次涉及的全部收件箱条目，撤销时放回待处理 */
  inboxIds: string[];
  /** 本次新建的实体，撤销时软删除 */
  created: { kind: 'task' | 'archive'; id: string }[];
}

const UNDO_SETTING_KEY = 'capture.undoLog';
const MAX_UNDO_BATCH = 200;

/** 从分类结果里挑出"本次新建的实体"，供撤销时反向清理 */
function toCreatedRefs(results: readonly ClassifyResult[]): { kind: 'task' | 'archive'; id: string }[] {
  return results
    .filter((result): result is ClassifyResult & { createdKind: 'task' | 'archive' } =>
      result.createdKind === 'task' || result.createdKind === 'archive',
    )
    .map((result) => ({ kind: result.createdKind, id: result.createdId }));
}

/**
 * 写入检索索引。索引失败绝不能影响捕获：
 * 出问题时只记一行警告，内容仍已安全落库，可用 search.reindexAll() 重建。
 */
function indexInbox(database: DatabaseSync, item: InboxItem): void {
  try {
    indexEntity(database, {
      entityType: 'inbox',
      entityId: item.id,
      title: '',
      // 原文一并入索引，这样按"下周三"这类被剥离的片段也能搜回原始输入
      body: `${item.body} ${item.rawInput ?? ''}`.trim(),
    });
  } catch (error) {
    console.warn(`[capture] 索引收件箱条目失败（不影响保存）：${String(error)}`);
  }
}

export interface CaptureService {
  quickCapture(input: { text: string; kindHint?: InboxKindHint | null }): { item: InboxItem; parsed: ParsedDate | null };
  listPending(options?: { limit?: number }): InboxItem[];
  countPending(): number;
  classify(id: string, target: ClassifyTarget): ClassifyResult;
  classifyMany(ids: string[], target: ClassifyTarget): ClassifyResult[];
  undoLastClassification(): boolean;
  lastUndoAt(): string | null;
}

export function createCaptureService(database: DatabaseSync): CaptureService {
  const boundaryHour = (): number => getDayBoundaryHour(database);

  function currentDayKey(): string {
    return todayKey(boundaryHour(), new Date());
  }

  function readUndo(): UndoRecord | null {
    return getSetting<UndoRecord | null>(database, UNDO_SETTING_KEY, null);
  }

  function writeUndo(record: UndoRecord | null): void {
    setSetting(database, UNDO_SETTING_KEY, record);
  }

  /**
   * 把一条待处理条目变成目标实体（或丢弃）。
   * 所有写入在同一事务内，要么全部成功要么全部回滚。
   */
  function classifyOne(id: string, target: ClassifyTarget, dayKey: string, at: string): ClassifyResult {
    const item = getInboxItem(database, id);
    if (item === undefined) {
      throw new InvalidTransitionError(`收件箱条目不存在或已处理：${id}`);
    }
    if (item.status !== 'pending') {
      throw new InvalidTransitionError(`收件箱条目已是 ${item.status} 状态，不能重复分类：${id}`);
    }

    if (target.kind === 'discard') {
      archiveInboxItem(database, id);
      return { inboxId: id, createdKind: 'inbox', createdId: id };
    }

    if (target.kind === 'archive') {
      const archive = createArchive(database, {
        kind: target.archiveKind ?? 'note',
        title: item.body,
        body: item.rawInput !== null && item.rawInput !== item.body ? item.rawInput : null,
        dayKey,
      });
      markConverted(database, id, `archive:${archive.id}`);
      return { inboxId: id, createdKind: 'archive', createdId: archive.id };
    }

    const task = createTask(database, {
      title: item.body,
      projectId: target.projectId ?? null,
      priority: target.priority ?? 'normal',
      dueDate: target.dueDate ?? item.parsedDue,
      sourceInboxId: id,
    });
    markConverted(database, id, `task:${task.id}`);
    return { inboxId: id, createdKind: 'task', createdId: task.id };
  }

  return {
    quickCapture(input) {
      const text = input.text;
      // 去掉首尾空白；即使全是空白也照存，避免"我明明按了回车却没存"的错觉
      const trimmed = text.trim();
      const at = nowIso();
      const dayKey = dayKeyFromIso(at, boundaryHour());
      const parsed = parseDate(trimmed, { today: dayKey });
      const title = parsed === null ? trimmed : stripParsedDate(trimmed, parsed);
      // 标题被剥离过才保留原文，便于回溯"我当时到底写了什么"
      const rawInput = title === trimmed ? null : trimmed;

      const item = withTx(database, () =>
        createInboxItem(database, {
          body: title.length === 0 ? trimmed : title,
          parsedDue: parsed?.dayKey ?? null,
          kindHint: input.kindHint ?? null,
          rawInput,
        }),
      );
      indexInbox(database, item);
      return { item, parsed };
    },

    listPending(options = {}) {
      return listPendingInbox(database, options.limit ?? 50);
    },

    countPending() {
      return countPendingInbox(database);
    },

    classify(id, target) {
      return withTx(database, () => {
        const at = nowIso();
        const result = classifyOne(id, target, dayKeyFromIso(at, boundaryHour()), at);
        writeUndo({
          at,
          inboxIds: [id],
          created: toCreatedRefs([result]),
        });
        return result;
      });
    },

    classifyMany(ids, target) {
      if (ids.length === 0) return [];
      if (ids.length > MAX_UNDO_BATCH) {
        throw new InvalidTransitionError(`一次最多处理 ${MAX_UNDO_BATCH} 条，收到 ${ids.length} 条`);
      }
      return withTx(database, () => {
        const at = nowIso();
        const dayKey = dayKeyFromIso(at, boundaryHour());
        const results = ids.map((id) => classifyOne(id, target, dayKey, at));
        writeUndo({ at, inboxIds: [...ids], created: toCreatedRefs(results) });
        return results;
      });
    },

    /**
     * 撤销上一次分类：把本次新建的实体软删除，并把收件箱条目放回待处理。
     * 只支持撤销最近一次，避免撤销栈带来的复杂度。
     */
    undoLastClassification() {
      const record = readUndo();
      if (record === null) return false;

      return withTx(database, () => {
        for (const entry of record.created) {
          if (entry.kind === 'task') deleteTask(database, entry.id);
          else deleteArchive(database, entry.id);
        }

        for (const inboxId of record.inboxIds) {
          const item = getInboxItem(database, inboxId);
          if (item === undefined) continue;
          if (item.status === 'converted' || item.status === 'archived') {
            // 放回待处理，并清掉指向已被删除实体的 converted_to
            database
              .prepare(`UPDATE inbox_items SET status = 'pending', converted_to = NULL, updated_at = ? WHERE id = ?`)
              .run(nowIso(), inboxId);
          }
        }

        writeUndo(null);
        return true;
      });
    },

    lastUndoAt() {
      return readUndo()?.at ?? null;
    },
  };
}

/** 供界面启用/禁用"撤销"按钮：上一次分类是否还值得撤销 */
export function canUndoClassification(database: DatabaseSync): boolean {
  return getSetting<UndoRecord | null>(database, UNDO_SETTING_KEY, null) !== null;
}
