// 资料服务：资料（指针）+ 入口 + 挂靠 的组合操作。
//
// 需求 §4.1 的三条硬规则在这里落地：
//   M1 **资料必须挂靠** —— 创建时要求至少一个目标；配 verify 自检兜底
//   M2 **绝不自动关联"当前正在做的任务"** —— 目标必须由调用方显式传入，本层不猜
//   M3 **只存指针** —— 只写 target 文本，不落文件本体，也不校验可达性
//
// 为什么"必须挂靠"在这里校验而不是数据库：它是**聚合约束**
// （一条资料可以有零行 link），SQLite 表达不了。
// 对比：任务焦点的唯一性是一条行内约束，就该由部分唯一索引保证（见迁移 005）。

import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../db/index.ts';
import {
  createArchive, createEntry, deleteArchive, deleteEntry, getArchive, getProject, getTask,
  linkMaterialIfAbsent, listArchives, listArchivesByIds, listArchivesLinkedTo, listEntries,
  listEntriesForArchives, listLinks, listLinksForArchives, listOrphanArchives, unlinkMaterial,
  updateArchive, updateEntry,
} from '../repo/index.ts';
import { createIndexer } from './indexer.ts';
import { assertNonEmptyText } from '../domain/rules.ts';
import { InvalidTransitionError, NotFoundError, ValidationError } from '../domain/errors.ts';
import type { MaterialEntry, MaterialLinkType, ArchiveItem } from '../domain/types.ts';

/** 挂靠目标（已解析出标题，供界面直接显示） */
export interface MaterialLinkTarget {
  type: MaterialLinkType;
  id: string;
  title: string;
}

export interface Material {
  id: string;
  title: string | null;
  entries: MaterialEntry[];
  links: MaterialLinkTarget[];
  createdAt: string;
  updatedAt: string;
}

/** 创建/更新时提交的入口（顺序即显示顺序，见需求 §4.2 D2） */
export interface EntryInput {
  kind: MaterialEntry['kind'];
  target: string;
  note?: string | null;
}

export interface MaterialService {
  /**
   * 创建资料。
   *
   * **必须给至少一个挂靠目标**（M1）。这里刻意没有 `targets` 可选的版本 ——
   * 让人没法"顺手创建一条没着落的资料"。
   */
  create(input: { title?: string | null; entries: EntryInput[]; targets: { type: MaterialLinkType; id: string }[] }): Material;

  get(id: string): Material;
  /** 列出资料；`orphanOnly` 用于资料页的"未挂靠"筛选 */
  list(options?: { orphanOnly?: boolean; limit?: number }): Material[];
  /** 挂靠在某个任务/项目上的资料（任务详情的折叠行用） */
  listForTarget(type: MaterialLinkType, id: string): Material[];

  /**
   * 更新资料：标题、入口、挂靠三者都按**整体替换**处理。
   * 入口的顺序即数组顺序（需求 §4.2 D2 的"按常用程度排序"）。
   */
  update(id: string, patch: { title?: string | null; entries?: EntryInput[]; targets?: { type: MaterialLinkType; id: string }[] }): Material;

  /** 追加挂靠（幂等）；资料页的"改/追加归属"用它 */
  link(id: string, targets: { type: MaterialLinkType; id: string }[]): Material;
  /** 解除挂靠；若因此变成零挂靠，**拒绝**（否则违反 M1） */
  unlink(id: string, target: { type: MaterialLinkType; id: string }): Material;

  /** 删除资料（软删除，进回收站） */
  remove(id: string): void;

  /** 一条资料的入口原文（供界面"复制路径"与多选打开） */
  entryTargets(id: string): string[];
}

/** 校验挂靠目标真实存在。指向不存在的对象就是孤儿挂靠（见 materialRepo 的说明） */
function assertTargetExists(database: DatabaseSync, target: { type: MaterialLinkType; id: string }): void {
  if (target.type === 'task') {
    if (getTask(database, target.id) === undefined) {
      throw new NotFoundError(`任务不存在，无法挂靠：${target.id}`);
    }
    return;
  }
  if (getProject(database, target.id) === undefined) {
    throw new NotFoundError(`项目不存在，无法挂靠：${target.id}`);
  }
}

function assertTargets(database: DatabaseSync, targets: readonly { type: MaterialLinkType; id: string }[]): void {
  // 去重：同一条资料挂同一个目标两次没有意义（库里有主键约束，但报错信息不友好）
  const seen = new Set<string>();
  for (const target of targets) {
    const key = `${target.type}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assertTargetExists(database, target);
  }
}

export function createMaterialService(database: DatabaseSync): MaterialService {
  const indexer = createIndexer(database);

  /** 按顺序整体替换入口：已有的按位置更新，多出的软删除，缺少的新建 */
  function replaceEntries(archiveId: string, entries: readonly EntryInput[]): void {
    if (entries.length === 0) {
      throw new ValidationError('一条资料至少要有一个入口（否则它就不是指针了）');
    }
    const existing = listEntries(database, archiveId);
    entries.forEach((input, index) => {
      const target = assertNonEmptyText(input.target, '入口内容');
      const current = existing[index];
      if (current === undefined) {
        createEntry(database, { archiveId, kind: input.kind, target, note: input.note ?? null });
      } else {
        updateEntry(database, current.id, {
          kind: input.kind,
          target,
          note: input.note ?? null,
          sortOrder: index + 1,
        });
      }
    });
    for (const stale of existing.slice(entries.length)) deleteEntry(database, stale.id);
  }

  function replaceTargets(archiveId: string, targets: readonly { type: MaterialLinkType; id: string }[]): void {
    if (targets.length === 0) {
      throw new ValidationError('资料必须挂靠到至少一个任务或项目（否则它会变成没人管的堆积）');
    }
    assertTargets(database, targets);
    // 先解除不在新集合里的，再补上新的 —— 保留已存在的（挂靠时间有意义）
    const keep = new Set(targets.map((t) => `${t.type}:${t.id}`));
    for (const link of listLinks(database, archiveId)) {
      if (!keep.has(`${link.targetType}:${link.targetId}`)) {
        unlinkMaterial(database, archiveId, link.targetType, link.targetId);
      }
    }
    for (const target of targets) linkMaterialIfAbsent(database, archiveId, target.type, target.id);
  }

  /** 组装对外结构：资料 + 入口 + 已解析标题的挂靠 */
  function toMaterial(archive: ArchiveItem, entries: MaterialEntry[], targets: MaterialLinkTarget[]): Material {
    return {
      id: archive.id,
      title: archive.title,
      entries,
      links: targets,
      createdAt: archive.createdAt,
      updatedAt: archive.updatedAt,
    };
  }

  function resolveTargets(links: readonly { targetType: MaterialLinkType; targetId: string }[]): MaterialLinkTarget[] {
    return links.map((link) => {
      const title = link.targetType === 'task'
        ? getTask(database, link.targetId)?.title
        : getProject(database, link.targetId)?.title;
      return { type: link.targetType, id: link.targetId, title: title ?? '（已删除）' };
    });
  }

  function loadOne(id: string): Material {
    const archive = getArchive(database, id);
    if (archive === undefined) throw new NotFoundError(`资料不存在：${id}`);
    return toMaterial(archive, listEntries(database, id), resolveTargets(listLinks(database, id)));
  }

  /** 批量组装，避免列表里逐条查询（N+1），也避免"取全表再过滤" */
  function loadMany(ids: readonly string[]): Material[] {
    const archives = listArchivesByIds(database, ids);
    const entriesByArchive = listEntriesForArchives(database, ids);
    const linksByArchive = listLinksForArchives(database, ids);
    return archives.map((archive) => toMaterial(
      archive,
      entriesByArchive.get(archive.id) ?? [],
      resolveTargets(linksByArchive.get(archive.id) ?? []),
    ));
  }

  return {
    create(input) {
      const entries = input.entries;
      if (entries.length === 0) {
        throw new ValidationError('一条资料至少要有一个入口（否则它就不是指针了）');
      }
      // 先校验挂靠，再写库：避免"资料建好了但挂靠非法"的半成品
      if (input.targets.length === 0) {
        throw new ValidationError('资料必须挂靠到至少一个任务或项目（需求 §4.1 规则 M1）');
      }
      assertTargets(database, input.targets);

      return withTx(database, () => {
        const archive = createArchive(database, { title: input.title ?? null });
        replaceEntries(archive.id, entries);
        replaceTargets(archive.id, input.targets);
        const material = loadOne(archive.id);
        indexer.archive(getArchive(database, archive.id)!);
        return material;
      });
    },

    get(id) {
      return loadOne(id);
    },

    list(options = {}) {
      const ids = options.orphanOnly === true
        ? listOrphanArchives(database)
        : listArchives(database, { limit: options.limit ?? 200 }).map((item) => item.id);
      return loadMany(ids);
    },

    listForTarget(type, id) {
      return loadMany(listArchivesLinkedTo(database, type, id));
    },

    update(id, patch) {
      if (getArchive(database, id) === undefined) throw new NotFoundError(`资料不存在：${id}`);
      return withTx(database, () => {
        if (patch.title !== undefined) updateArchive(database, id, { title: patch.title });
        if (patch.entries !== undefined) replaceEntries(id, patch.entries);
        if (patch.targets !== undefined) replaceTargets(id, patch.targets);
        const material = loadOne(id);
        indexer.archive(getArchive(database, id)!);
        return material;
      });
    },

    link(id, targets) {
      if (getArchive(database, id) === undefined) throw new NotFoundError(`资料不存在：${id}`);
      return withTx(database, () => {
        assertTargets(database, targets);
        for (const target of targets) linkMaterialIfAbsent(database, id, target.type, target.id);
        return loadOne(id);
      });
    },

    unlink(id, target) {
      if (getArchive(database, id) === undefined) throw new NotFoundError(`资料不存在：${id}`);
      return withTx(database, () => {
        const remaining = listLinks(database, id).filter(
          (link) => !(link.targetType === target.type && link.targetId === target.id),
        );
        // M1：不能解除到一条挂靠都不剩 —— 否则这条资料就成了没人管的堆积
        if (remaining.length === 0) {
          throw new InvalidTransitionError(
            '这是它最后一个挂靠。资料必须挂在任务或项目上 —— 想丢弃请删除这条资料。',
          );
        }
        unlinkMaterial(database, id, target.type, target.id);
        return loadOne(id);
      });
    },

    remove(id) {
      withTx(database, () => {
        if (getArchive(database, id) === undefined) throw new NotFoundError(`资料不存在：${id}`);
        deleteArchive(database, id);
        indexer.remove('archive', id);
      });
    },

    entryTargets(id) {
      const archive = getArchive(database, id);
      if (archive === undefined) throw new NotFoundError(`资料不存在：${id}`);
      return listEntries(database, id).map((entry) => entry.target);
    },
  };
}
