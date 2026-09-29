// 日志服务：每日汇总与手工正文。
//
// 关键决策（docs/design.md §6.4）：自动汇总**不落库**，是运行时投影。
// 若把它写进 daily_logs.body，任务状态一变历史日志就变成错的。
// 因此这里只负责"算出来"和"存我手写的那部分"。

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  deleteDailyLog, getDailyLog, listArchivesCreatedBetween, listDailyLogs,
  listInboxCreatedBetween, listOpenTasksDueOnOrBefore, listProgressByDay,
  listSubtasksCompletedBetween, listTasksCompletedBetween, listTasksCreatedBetween,
  saveDailyLog,
} from '../repo/index.ts';
import { getDayBoundaryHour } from '../repo/settingsRepo.ts';
import { dayRange } from '../day/dayKey.ts';
import type { ArchiveItem, DailyLog, InboxItem, ProgressEntry, Subtask, Task } from '../domain/types.ts';

export interface CompletedSubtask {
  subtask: Subtask;
  /** 所属任务标题，日志里只写子任务名会看不懂上下文 */
  taskTitle: string;
}

export interface JournalSummary {
  dayKey: string;
  /** 真实时间区间（左闭右开），便于排查归属是否正确 */
  range: { startIso: string; endIso: string };
  completedTasks: Task[];
  completedSubtasks: CompletedSubtask[];
  createdTasks: Task[];
  createdInbox: InboxItem[];
  createdArchives: ArchiveItem[];
  /** 到期日早于当天且仍未结束的任务（顺延项） */
  carriedOver: Task[];
  /** 当天的卡点记录 */
  blockers: ProgressEntry[];
  /** 当天的全部进展记录，按时间正序 */
  timeline: ProgressEntry[];
  /** 已保存的手工正文 */
  log: DailyLog | null;
  counts: { completed: number; created: number; blockers: number; carriedOver: number };
}

export interface JournalService {
  summarize(dayKey: string): JournalSummary;
  get(dayKey: string): DailyLog | null;
  /** 保存手工正文；自动汇总部分不落库 */
  save(dayKey: string, body: string): DailyLog;
  list(options?: { from?: string; to?: string; limit?: number }): DailyLog[];
  delete(dayKey: string): void;
}

export function createJournalService(database: DatabaseSync): JournalService {
  return {
    summarize(dayKey) {
      const { start, end } = dayRange(dayKey, getDayBoundaryHour(database));
      const startIso = start.toISOString();
      const endIso = end.toISOString();

      const completedTasks = listTasksCompletedBetween(database, startIso, endIso);
      const completedSubtasks = listSubtasksCompletedBetween(database, startIso, endIso);
      const createdTasks = listTasksCreatedBetween(database, startIso, endIso);
      const createdInbox = listInboxCreatedBetween(database, startIso, endIso);
      const createdArchives = listArchivesCreatedBetween(database, startIso, endIso);

      // 进展记录按**归属日**取，不按真实时刻区间：
      // 补录一条"三天前做的事"时 day_key 是那一天而 occurred_at 是现在，
      // 若按时间区间查询，这条记录会被错误地排除在所属日期之外。
      const timeline = listProgressByDay(database, dayKey);
      const blockers = timeline.filter((entry) => entry.kind === 'blocker');
      const carriedOver = listOpenTasksDueOnOrBefore(database, dayKey).filter(
        (task) => task.dueDate !== null && task.dueDate < dayKey,
      );

      return {
        dayKey,
        range: { startIso, endIso },
        completedTasks,
        completedSubtasks,
        createdTasks,
        createdInbox,
        createdArchives,
        carriedOver,
        blockers,
        timeline,
        log: getDailyLog(database, dayKey) ?? null,
        counts: {
          completed: completedTasks.length + completedSubtasks.length,
          created: createdTasks.length + createdInbox.length,
          blockers: blockers.length,
          carriedOver: carriedOver.length,
        },
      };
    },

    get(dayKey) {
      return getDailyLog(database, dayKey) ?? null;
    },

    save(dayKey, body) {
      return withTx(database, () => saveDailyLog(database, dayKey, body));
    },

    list(options = {}) {
      return listDailyLogs(database, options);
    },

    delete(dayKey) {
      withTx(database, () => deleteDailyLog(database, dayKey));
    },
  };
}
