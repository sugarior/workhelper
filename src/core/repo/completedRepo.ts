// 已完成任务的跨天总览查询（需求 F-09b）。
//
// 存在的理由：需求 P4 把"复盘是编的"列为核心痛点，G3 承诺"写日报/周报时是导出而不是回忆"，
// 但功能清单里此前只有**单天**汇总（F-20），写周报仍要逐天翻日志。
// 本模块提供"某时间段内做完了什么"的一次性查询。
//
// 口径：按 **completed_at 这个真实时刻** 的区间查，而不是 day_key。
// 因为任务与子任务都没有独立的归属日字段（只有完成时刻），
// 这与 journalService 里"任务按时间戳取、进展按 day_key 取"的口径一致。
//
// 输出统一成 CompletedEntry 扁平结构：任务与子任务用同一个形状，
// 界面因此只需要一套渲染逻辑（子任务多带一个 taskTitle）。

import type { DatabaseSync } from 'node:sqlite';
import { queryAll } from '../db/connection.ts';

export interface CompletedEntry {
  kind: 'task' | 'subtask';
  id: string;
  title: string;
  /** 所属项目名；任务无项目时为 null（子任务沿 父任务 → 项目 补上） */
  projectTitle: string | null;
  /** 仅子任务有：父任务名 */
  taskTitle: string | null;
  completedAt: string;
}

interface CompletedRow {
  id: string;
  title: string;
  project_title: string | null;
  task_title: string | null;
  completed_at: string;
}

interface SubtaskCompletedRow extends CompletedRow {
  parent_task_id: string | null;
  parent_project_id: string | null;
}

/**
 * 区间内完成的任务与子任务，按 completed_at 倒序。
 *
 * `startIso` / `endIso` 由调用方按日界换算好（见 trackingService.completedView），
 * 本层不与日界逻辑耦合。
 */
export function listCompletedBetween(
  database: DatabaseSync,
  startIso: string,
  endIso: string,
  limit = 1000,
): CompletedEntry[] {
  const tasks = queryAll<CompletedRow>(
    database,
    `SELECT t.id, t.title,
       (SELECT p.title FROM projects p WHERE p.id = t.project_id) AS project_title,
       NULL AS task_title,
       t.completed_at
     FROM tasks t
     WHERE t.deleted_at IS NULL
       AND t.status = 'done'
       AND t.completed_at IS NOT NULL
       AND t.completed_at >= ? AND t.completed_at < ?
     ORDER BY t.completed_at DESC`,
    startIso,
    endIso,
  );

  const subtasks = queryAll<SubtaskCompletedRow>(
    database,
    `SELECT s.id, s.title,
       NULL AS project_title,
       (SELECT t.title FROM tasks t WHERE t.id = s.task_id) AS task_title,
       s.completed_at,
       s.task_id AS parent_task_id,
       (SELECT t.project_id FROM tasks t WHERE t.id = s.task_id) AS parent_project_id
     FROM subtasks s
     WHERE s.deleted_at IS NULL
       AND s.status = 'done'
       AND s.completed_at IS NOT NULL
       AND s.completed_at >= ? AND s.completed_at < ?
     ORDER BY s.completed_at DESC`,
    startIso,
    endIso,
  );

  // 子任务的项目名要从父任务补上来，批量取名避免逐条回表
  const projectIds = new Set<string>();
  for (const row of subtasks) {
    if (row.parent_project_id !== null) projectIds.add(row.parent_project_id);
  }
  const projectTitles = new Map<string, string>();
  if (projectIds.size > 0) {
    const ids = [...projectIds];
    const placeholders = ids.map(() => '?').join(', ');
    for (const row of queryAll<{ id: string; title: string }>(
      database,
      `SELECT id, title FROM projects WHERE id IN (${placeholders})`,
      ...ids,
    )) {
      projectTitles.set(row.id, row.title);
    }
  }

  const entries: CompletedEntry[] = [
    ...tasks.map((row) => ({
      kind: 'task' as const,
      id: row.id,
      title: row.title,
      projectTitle: row.project_title,
      taskTitle: null,
      completedAt: row.completed_at,
    })),
    ...subtasks.map((row) => ({
      kind: 'subtask' as const,
      id: row.id,
      title: row.title,
      projectTitle: row.parent_project_id === null ? null : projectTitles.get(row.parent_project_id) ?? null,
      taskTitle: row.task_title,
      completedAt: row.completed_at,
    })),
  ];

  entries.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return entries.slice(0, limit);
}
