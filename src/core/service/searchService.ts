// 搜索服务：在 FTS 命中之上补齐"这条记录现在长什么样"。
//
// 索引里存的是写入那一刻的文本；实体后续被改名后索引可能滞后。
// 因此展示时优先回源读取实体，取不到再回退到索引里的文本，
// 这样即使索引过期也不会显示错误内容。

import type { DatabaseSync } from 'node:sqlite';
import {
  countIndexed, getArchive, getDailyLog, getInboxItem, getProject, getSubtask, getTask,
  indexEntity, listArchives, listDailyLogs, listEntries, listProjects, listSubtasks, listTasks,
  removeEntity, rebuildIndex, search as searchRepo,
} from '../repo/index.ts';
import type { IndexInput, SearchHit } from '../repo/searchRepo.ts';
import type { EntityType } from '../domain/types.ts';

export interface ResolvedHit extends SearchHit {
  /** 实体当前标题（回源读取失败时退回索引文本） */
  displayTitle: string;
  /** 该实体当前是否还存在（索引可能残留已删除内容） */
  alive: boolean;
  entityLabel: string;
}

export interface SearchService {
  search(query: string, options?: { types?: readonly EntityType[]; limit?: number }): ResolvedHit[];
  /** 直接搜索引，不回源（用于诊断与测试） */
  searchIndexOnly(query: string, options?: { types?: readonly EntityType[]; limit?: number }): SearchHit[];
  reindexAll(): number;
  indexEntity(input: IndexInput): void;
  removeEntity(entityType: EntityType, entityId: string): void;
  countIndexed(): number;
}

const ENTITY_LABELS: Readonly<Record<EntityType, string>> = {
  project: '项目',
  task: '任务',
  subtask: '子任务',
  progress: '进展',
  inbox: '收件箱',
  archive: '资料',
  log: '日志',
};

/** 回源读取实体当前标题。返回 undefined 表示实体已不存在。 */
function resolveTitle(database: DatabaseSync, hit: SearchHit): string | undefined {
  switch (hit.entityType) {
    case 'task': {
      const task = getTask(database, hit.entityId);
      return task === undefined ? undefined : task.title;
    }
    case 'project': {
      const project = getProject(database, hit.entityId);
      return project === undefined ? undefined : project.title;
    }
    case 'subtask': {
      const subtask = getSubtask(database, hit.entityId);
      return subtask === undefined ? undefined : subtask.title;
    }
    case 'inbox': {
      const item = getInboxItem(database, hit.entityId);
      return item === undefined ? undefined : item.body;
    }
    case 'archive': {
      const archive = getArchive(database, hit.entityId);
      return archive === undefined ? undefined : (archive.title ?? archive.body ?? '');
    }
    case 'log': {
      const log = getDailyLog(database, hit.entityId);
      return log === undefined ? undefined : `日志 ${log.dayKey}`;
    }
    case 'progress': {
      const row = database
        .prepare('SELECT body FROM progress_entries WHERE id = ? AND deleted_at IS NULL')
        .get(hit.entityId) as { body: string } | undefined;
      return row?.body;
    }
  }
}

/** 把当前库里的全部文本重新灌进索引。用于索引损坏或折叠算法变更后的兜底。 */
export function collectAllIndexInputs(database: DatabaseSync): IndexInput[] {
  const inputs: IndexInput[] = [];

  for (const project of listProjects(database)) {
    inputs.push({ entityType: 'project', entityId: project.id, title: project.title, body: project.goal ?? '' });
  }
  for (const task of listTasks(database)) {
    inputs.push({ entityType: 'task', entityId: task.id, title: task.title, body: task.detail ?? '' });
    for (const subtask of listSubtasks(database, task.id)) {
      inputs.push({ entityType: 'subtask', entityId: subtask.id, title: subtask.title });
    }
  }
  const progressRows = database
    .prepare('SELECT id, body FROM progress_entries WHERE deleted_at IS NULL')
    .all() as { id: string; body: string }[];
  for (const row of progressRows) {
    inputs.push({ entityType: 'progress', entityId: row.id, title: '', body: row.body });
  }
  const inboxRows = database
    .prepare('SELECT id, body, raw_input FROM inbox_items WHERE deleted_at IS NULL')
    .all() as { id: string; body: string; raw_input: string | null }[];
  for (const row of inboxRows) {
    inputs.push({ entityType: 'inbox', entityId: row.id, title: '', body: `${row.body} ${row.raw_input ?? ''}`.trim() });
  }
  const archiveRows = database
    .prepare('SELECT id, title FROM archive_items WHERE deleted_at IS NULL')
    .all() as { id: string; title: string | null }[];
  // 资料的检索文本来自**入口**（路径 / URL + 各自注释），不再是 archive_items.body。
  // 需求 F-15 要求能搜到资料的路径；见设计 §4.5。
  for (const row of archiveRows) {
    const entries = listEntries(database, row.id);
    inputs.push({
      entityType: 'archive',
      entityId: row.id,
      title: row.title ?? '',
      body: entries.map((entry) => `${entry.target} ${entry.note ?? ''}`.trim()).join(' '),
    });
  }
  for (const log of listDailyLogs(database, { limit: 1000 })) {
    inputs.push({ entityType: 'log', entityId: log.id, title: '', body: log.body ?? '' });
  }
  return inputs;
}

export function createSearchService(database: DatabaseSync): SearchService {
  return {
    search(query, options = {}) {
      const hits = searchRepo(database, query, options);
      return hits.map((hit) => {
        const current = resolveTitle(database, hit);
        return {
          ...hit,
          displayTitle: current ?? hit.title,
          alive: current !== undefined,
          entityLabel: ENTITY_LABELS[hit.entityType],
        };
      });
    },

    searchIndexOnly(query, options = {}) {
      return searchRepo(database, query, options);
    },

    reindexAll() {
      return rebuildIndex(database, () => collectAllIndexInputs(database));
    },

    indexEntity(input) {
      indexEntity(database, input);
    },

    removeEntity(entityType, entityId) {
      removeEntity(database, entityType, entityId);
    },

    countIndexed() {
      return countIndexed(database);
    },
  };
}
