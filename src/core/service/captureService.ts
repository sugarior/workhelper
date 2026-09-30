// 捕获服务：把"混乱输入"变成结构的第一步。
//
// 设计约束（需求 §6.3）：快记通路不得失败。全程同步、单事务、无网络，
// 日期解析失败只会降级为"原样存标题"，绝不阻断保存。

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  archiveInboxItem, countPendingInbox, createArchive, createInboxItem, createProject, createTask,
  deleteArchive, deleteInboxItem, deleteProject, deleteTask, getInboxItem, listPendingInbox,
  markConverted, getDayBoundaryHour, getSetting, setSetting,
} from '../repo/index.ts';
import { parseDate, stripParsedDate } from '../day/parseDate.ts';
import { createIndexer } from './indexer.ts';
import { dayKeyFromIso, nowIso } from '../domain/clock.ts';
import { todayKey } from '../day/dayKey.ts';
import { InvalidTransitionError, NotFoundError } from '../domain/errors.ts';
import type { ArchiveKind, EntityType, InboxItem, InboxKindHint, Task } from '../domain/types.ts';
import type { ParsedDate } from '../day/parseDate.ts';

/** 分类目标：把一条收件箱碎片变成什么 */
export type ClassifyTarget =
  | { kind: 'task'; projectId?: string | null; dueDate?: string | null; priority?: Task['priority'] }
  /**
   * 碎片本身就是"一件事"（需求 F-04 的「转项目」）。
   * 只新建项目并把它当作后续任务与子任务的容器 —— **不在这里拆分**，
   * 拆解留到项目页去做。这就是"当场只需判断它是项目"的价值：
   * 若先转成任务，之后没有任何路径能把它升级为项目。
   */
  | { kind: 'project'; goal?: string | null }
  | { kind: 'archive'; archiveKind?: ArchiveKind }
  | { kind: 'discard' };

/** 分类会新建的实体类型（discard 不新建，故不在内） */
export type CreatedKind = 'task' | 'project' | 'archive';

export interface ClassifyResult {
  inboxId: string;
  /** 生成的实体类型；discard 时为 'inbox'（只是被丢弃） */
  createdKind: EntityType;
  createdId: string;
}

/**
 * 分类结果的用户可见名称。
 *
 * 刻意做成查表而不是三元表达式：原先 CLI 里写的是
 * `kind === 'task' ? '任务' : kind === 'archive' ? '资料' : '已丢弃'`，
 * 于是**新增 project 之后它落进兜底分支被显示成"已丢弃"**——
 * 功能是对的，反馈是错的。查表 + 穷尽键能避免这类静默错误。
 */
export const CLASSIFY_RESULT_LABELS: Readonly<Record<'task' | 'project' | 'archive' | 'inbox', string>> = {
  task: '任务',
  project: '项目',
  archive: '资料',
  inbox: '已丢弃',
};

/** 撤销日志：一次分类操作的全部影响，存在 settings 里，避免为此加表 */
interface UndoRecord {
  at: string;
  /** 本次涉及的全部收件箱条目，撤销时放回待处理 */
  inboxIds: string[];
  /** 本次新建的实体，撤销时软删除 */
  created: { kind: CreatedKind; id: string }[];
}

const UNDO_SETTING_KEY = 'capture.undoLog';
const MAX_UNDO_BATCH = 200;

/**
 * 从分类结果里挑出"本次新建的实体"，供撤销时反向清理。
 * 注意 discard 不在内：它不新建任何实体，只需把收件箱条目放回待处理。
 */
function toCreatedRefs(results: readonly ClassifyResult[]): { kind: CreatedKind; id: string }[] {
  return results
    .filter((result): result is ClassifyResult & { createdKind: CreatedKind } =>
      result.createdKind === 'task' || result.createdKind === 'project' || result.createdKind === 'archive',
    )
    .map((result) => ({ kind: result.createdKind, id: result.createdId }));
}

export interface CaptureService {
  /**
   * 快记。
   * dryRun=true 时只做解析、不写库——快记窗用它实现"边打字边显示截止日"，
   * 而不必为一个纯预览再造一个只读接口。
   */
  quickCapture(input: {
    text: string;
    kindHint?: InboxKindHint | null;
    dryRun?: boolean;
  }): { item: InboxItem | null; parsed: ParsedDate | null; title: string };
  listPending(options?: { limit?: number }): InboxItem[];
  countPending(): number;
  classify(id: string, target: ClassifyTarget): ClassifyResult;
  classifyMany(ids: string[], target: ClassifyTarget): ClassifyResult[];
  undoLastClassification(): boolean;
  lastUndoAt(): string | null;
  /** 删除收件箱条目（误录纠正，进回收站）。与"丢弃"语义不同，见实现处注释 */
  deleteItem(id: string): void;
}

export function createCaptureService(database: DatabaseSync): CaptureService {
  const indexer = createIndexer(database);
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
      // 资料条目必须进索引：需求 F-11 要求能搜到资料全文。
      // 这里曾经漏接，导致分类产生的资料永远搜不到。
      indexer.archive(archive);
      return { inboxId: id, createdKind: 'archive', createdId: archive.id };
    }

    if (target.kind === 'project') {
      const project = createProject(database, {
        title: item.body,
        goal: target.goal ?? null,
      });
      markConverted(database, id, `project:${project.id}`);
      indexer.project(project);
      return { inboxId: id, createdKind: 'project', createdId: project.id };
    }

    const task = createTask(database, {
      title: item.body,
      projectId: target.projectId ?? null,
      priority: target.priority ?? 'normal',
      dueDate: target.dueDate ?? item.parsedDue,
      sourceInboxId: id,
    });
    markConverted(database, id, `task:${task.id}`);
    indexer.task(task);
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
      const stripped = parsed === null ? trimmed : stripParsedDate(trimmed, parsed);
      // 标题被剥离过才保留原文，便于回溯"我当时到底写了什么"
      const title = stripped.length === 0 ? trimmed : stripped;
      const rawInput = title === trimmed ? null : trimmed;

      if (input.dryRun === true) {
        return { item: null, parsed, title };
      }

      const item = withTx(database, () =>
        createInboxItem(database, {
          body: title,
          parsedDue: parsed?.dayKey ?? null,
          kindHint: input.kindHint ?? null,
          rawInput,
        }),
      );
      indexer.inbox(item);
      return { item, parsed, title };
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
          else if (entry.kind === 'project') deleteProject(database, entry.id);
          else deleteArchive(database, entry.id);
          indexer.remove(entry.kind, entry.id);
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

    /**
     * 删除收件箱条目（误录纠正），进回收站，可恢复。
     *
     * 与「丢弃」的区别（需求 F-04）：丢弃是"这条是垃圾，已处理完毕"，
     * 状态转为 archived 且不再出现；删除是"我根本不该记它"，属纠正操作。
     * 两者都保留数据，但语义与后续可见性不同。
     *
     * **守卫（硬规则 D1）**：只允许删除**待处理**的条目。
     * 已处理（已转出 / 已丢弃）的条目删除等于抹掉处理痕迹 ——
     * 要撤销就用「撤销上一次分类」，要清垃圾就用「丢弃」。
     */
    deleteItem(id) {
      withTx(database, () => {
        const item = getInboxItem(database, id);
        if (item === undefined) throw new NotFoundError(`收件箱条目不存在：${id}`);
        if (item.status !== 'pending') {
          const what = item.status === 'converted' ? '已转出' : '已丢弃';
          throw new InvalidTransitionError(
            `${what}的条目不能删除（那会抹掉处理痕迹）。要撤销请用「撤销上一次分类」。`,
          );
        }
        deleteInboxItem(database, id);
        indexer.remove('inbox', id);
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
