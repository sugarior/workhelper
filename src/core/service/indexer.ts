// 索引维护模块：把"写入数据后同步检索索引"这件事集中到一处。
//
// 为什么需要它：索引调用原本散落在各服务的写入路径里（8 处），
// 结果是漏接了两个真实场景——**分类产生的资料条目**与**日志正文**都没进索引，
// 而需求 F-11 明确要求能搜到它们。分散的横切关注点必然会被漏掉。
//
// 设计约束（需求 §6.3 的延伸）：索引失败绝不能影响业务写入。
// 内容此时已经安全落库，最坏情况只是暂时搜不到，可用 reindexAll() 重建。

import type { DatabaseSync } from 'node:sqlite';
import { indexEntity, removeEntity } from '../repo/index.ts';
import type { ArchiveItem, DailyLog, InboxItem, ProgressEntry, Project, Subtask, Task } from '../domain/types.ts';

export interface Indexer {
  task(task: Task): void;
  project(project: Project): void;
  subtask(subtask: Subtask): void;
  progress(entry: ProgressEntry): void;
  inbox(item: InboxItem): void;
  archive(item: ArchiveItem): void;
  log(entry: DailyLog): void;
  remove(entityType: 'project' | 'task' | 'subtask' | 'progress' | 'inbox' | 'archive' | 'log', id: string): void;
}

export function createIndexer(database: DatabaseSync): Indexer {
  /** 统一的失败兜底：只告警，不抛出 */
  function safely(action: () => void, what: string): void {
    try {
      action();
    } catch (error) {
      console.warn(`[search] 索引${what}失败（不影响保存，可用 reindex 重建）：${String(error)}`);
    }
  }

  return {
    task(task) {
      safely(() => indexEntity(database, {
        entityType: 'task',
        entityId: task.id,
        title: task.title,
        body: task.detail ?? '',
      }), '任务');
    },

    project(project) {
      safely(() => indexEntity(database, {
        entityType: 'project',
        entityId: project.id,
        title: project.title,
        body: project.goal ?? '',
      }), '项目');
    },

    subtask(subtask) {
      safely(() => indexEntity(database, {
        entityType: 'subtask',
        entityId: subtask.id,
        title: subtask.title,
      }), '子任务');
    },

    progress(entry) {
      safely(() => indexEntity(database, {
        entityType: 'progress',
        entityId: entry.id,
        title: '',
        body: entry.body,
      }), '进展记录');
    },

    inbox(item) {
      safely(() => indexEntity(database, {
        entityType: 'inbox',
        entityId: item.id,
        title: '',
        // 原文一并入索引，这样按被剥离掉的日期片段也能搜回原始输入
        body: `${item.body} ${item.rawInput ?? ''}`.trim(),
      }), '收件箱条目');
    },

    archive(item) {
      safely(() => indexEntity(database, {
        entityType: 'archive',
        entityId: item.id,
        title: item.title ?? '',
        body: item.body ?? '',
      }), '资料条目');
    },

    log(entry) {
      safely(() => indexEntity(database, {
        entityType: 'log',
        entityId: entry.id,
        title: '',
        body: entry.body ?? '',
      }), '日志');
    },

    remove(entityType, id) {
      safely(() => removeEntity(database, entityType, id), `清理（${entityType}）`);
    },
  };
}
