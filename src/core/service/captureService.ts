// 捕获服务：把"混乱输入"变成结构的第一步。
//
// 设计约束（需求 §6.3）：快记通路不得失败。全程同步、单事务、无网络，
// 日期解析失败只会降级为"原样存标题"，绝不阻断保存。

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  archiveInboxItem, countPendingInbox, createArchive, createInboxItem, createProject, createTask,
  deleteArchive, deleteProject, deleteTask, getInboxItem, listPendingInbox,
  markConverted, restoreConverted, getDayBoundaryHour, getSetting, setSetting,
} from '../repo/index.ts';
import { parseDate, stripParsedDate } from '../day/parseDate.ts';
import { createIndexer } from './indexer.ts';
import type { Indexer } from './indexer.ts';
import { dayKeyFromIso, nowIso } from '../domain/clock.ts';
import { todayKey } from '../day/dayKey.ts';
import { InvalidTransitionError, NotFoundError } from '../domain/errors.ts';
import type { ArchiveKind, EntityType, InboxItem, InboxKindHint, InboxStatus, Task } from '../domain/types.ts';
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
  inbox: '已忽略',
};

/**
 * 撤销日志：一次操作的全部影响，存在 settings 里，避免为此加表。
 *
 * `ignored` 记录"被忽略时它原本是什么状态"，这是**撤销能否正确工作**的关键：
 *  · 原本是 `pending` → 撤销只需把它放回待处理
 *  · 原本是 `converted` → 撤销要把它**恢复成已转出**，而不是放回待处理
 *    （否则收件箱会多出一条本该已处理的记录）
 *
 * 不带这个字段的是旧格式记录，按"全部放回待处理"处理（等价于旧行为）。
 */
interface UndoRecord {
  at: string;
  /** 本次涉及的全部收件箱条目，撤销时恢复 */
  inboxIds: string[];
  /** 本次新建的实体，撤销时软删除 */
  created: { kind: CreatedKind; id: string }[];
  /** 被忽略的条目及其忽略前的状态 */
  ignored?: { id: string; prevStatus: InboxStatus }[];
}

const UNDO_SETTING_KEY = 'capture.undoLog';
const MAX_UNDO_BATCH = 200;

/**
 * 忽略一条收件箱条目（"我不要这条"）。
 *
 * `classify` 的 `discard` 分支与 `ignoreItem` 共用这个实现 —— 它们是同一个动作的两个入口：
 * 前者是"整理时顺手忽略"，后者是"对单条直接忽略"。**不能写成两套逻辑**，
 * 否则两条路径的撤销记录、索引维护会逐渐分叉（本项目已因此栽过两次）。
 *
 * 放在模块层而不是某个 service 内部：两个调用方分属不同方法，
 * 写成闭包里的私有函数反而要来回传参。
 */
function archiveAndTrack(
  database: DatabaseSync,
  id: string,
  indexer: Indexer,
  at: string,
): void {
  const item = getInboxItem(database, id);
  if (item === undefined) throw new NotFoundError(`收件箱条目不存在：${id}`);
  archiveInboxItem(database, id);
  // 待处理的条目要从索引移除，否则搜出来点进去是空的；
  // 已转出的条目留着（它对应的实体也在索引里，两者不冲突）。
  if (item.status === 'pending') indexer.remove('inbox', id);
  // 记下"忽略前是什么状态"，撤销时要靠它还原（见 undoLastClassification）
  setSetting(database, UNDO_SETTING_KEY, {
    at,
    inboxIds: [id],
    created: [],
    ignored: [{ id, prevStatus: item.status }],
  } satisfies UndoRecord);
}

/**
 * 从分类结果里挑出"本次新建的实体"，供撤销时反向清理。
 * 注意 discard 不在内：它不新建任何实体，只改收件箱条目的状态。
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
  /**
   * 忽略收件箱条目 —— 收件箱**唯一**的"我不要这条"动作（F-04 修订）。
   * 待处理与已转出的条目都能用；幂等。
   */
  ignoreItem(id: string): void;
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
      // 与 ignoreItem 共用同一个实现：它们是同一个动作的两个入口
      archiveAndTrack(database, id, indexer, at);
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
     * 撤销上一次操作：把本次新建的实体软删除，并把收件箱条目恢复。
     * 只支持撤销最近一次，避免撤销栈带来的复杂度。
     *
     * 恢复成什么状态，取决于这次操作**是分类还是忽略**：
     *  · 分类（本次新建了实体）→ 条目回到**待处理**，并清掉 `converted_to`
     *    （它指向的实体刚被删掉，留着就是悬空引用）
     *  · 忽略 → 条目回到**忽略前的状态**。若一律放回待处理，
     *    收件箱会多出一条本该已处理的记录。
     *
     * 判据是 `record.created` 是否为空 —— 即"这次操作有没有转出新实体"。
     * 也可以让 ignoreItem 写一条带 prevStatus 的记录来区分，
     * 但那需要区分"哪条是刚转的、哪条是早就转过的"，反而更绕。
     */
    undoLastClassification() {
      const record = readUndo();
      if (record === null) return false;

      const wasIgnoreOnly = record.created.length === 0;

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

          if (wasIgnoreOnly) {
            // 忽略操作：还原成忽略前的状态。
            // 这里**保留 converted_to** —— 它是"这条曾转出过什么"的痕迹，
            // 也是下一次判断的依据。
            const prev = (record.ignored ?? []).find((entry) => entry.id === inboxId)?.prevStatus;
            if (prev === 'converted' && item.status === 'archived') restoreConverted(database, inboxId);
            else if (prev === 'pending' && item.status === 'archived') {
              database
                .prepare(`UPDATE inbox_items SET status = 'pending', updated_at = ? WHERE id = ?`)
                .run(nowIso(), inboxId);
            }
            continue;
          }

          // 分类操作：放回待处理，并清掉指向已被删除实体的 converted_to
          if (item.status === 'converted' || item.status === 'archived') {
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
   * 忽略一条收件箱条目（F-04 修订后的**唯一**"我不要它"动作）。
   *
   * 取代了原先并列的「丢弃」与「删除」：两者的用户决策完全相同
   * （都是"我不要这条"），差异只在实现（`status` vs `deleted_at`、
   * 30 天过期 vs 不过期）—— **把实现差异泄漏成用户决策是设计失败**，
   * 每次整理收件箱都要多做一个没有实际意义的判断。
   *
   * 对**已转出的条目**也能用：那只是标记掉一行审计痕迹，
   * **不影响任何任务/项目/资料**（`converted_to` 只是一条指向关系）。
   *
   * 幂等：已经忽略过的再点一次不报错。
   */
    ignoreItem(id) {
      withTx(database, () => {
        const item = getInboxItem(database, id);
        if (item === undefined) throw new NotFoundError(`收件箱条目不存在：${id}`);
        if (item.status === 'archived') return; // 幂等
        // 与 classify(discard) 共用同一个实现，避免两条路径的
        // 撤销记录与索引维护逐渐分叉
        archiveAndTrack(database, id, indexer, nowIso());
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
