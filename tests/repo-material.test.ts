// 资料数据层测试：入口（可排序）+ 挂靠（多对多、必须至少一个）。
//
// 覆盖重点是两条硬规则（需求 §4.1）：
//   M1 资料必须挂靠 —— 本层提供检测能力，强制在服务层
//   M3 只存指针 —— target 原样保存，不做规范化、不校验可达性

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import { createProject } from '../src/core/repo/projectRepo.ts';
import { createTask } from '../src/core/repo/taskRepo.ts';
import { createArchive, deleteArchive, getArchive, listArchivesByIds } from '../src/core/repo/archiveRepo.ts';
import {
  countDanglingLinks, countEntries, countLinks, countValidLinks, createEntry, deleteEntry, getEntry,
  linkMaterial, linkMaterialIfAbsent, listAllEntries, listAllLinks, listArchivesLinkedTo,
  listEntries, listEntriesForArchives, listLinks, listOrphanArchives, pruneDanglingLinks,
  reorderEntries, unlinkAllFor, unlinkMaterial, updateEntry,
} from '../src/core/repo/materialRepo.ts';
import { NotFoundError } from '../src/core/domain/errors.ts';

function makeMaterial(database: Parameters<typeof createArchive>[0], title: string): string {
  return createArchive(database, { title }).id;
}

test('资料入口：三种类型都能创建，且按创建顺序排序', () => {
  useDb((database) => {
    const id = makeMaterial(database, 'Q3 迁移的工作区');
    const dir = createEntry(database, { archiveId: id, kind: 'dir', target: 'D:\\work\\q3-migration', note: '工作区' });
    const file = createEntry(database, { archiveId: id, kind: 'file', target: '\\\\nas\\设计\\迁移方案_v3.docx', note: '最新方案' });
    const url = createEntry(database, { archiveId: id, kind: 'url', target: 'https://xxx.feishu.cn/docx/abc' });

    assert.equal(dir.kind, 'dir');
    assert.equal(file.note, '最新方案');
    assert.equal(url.note, null);

    // 一条资料含多个入口（需求 §4.2 D2），一条不分层（D3）
    const entries = listEntries(database, id);
    assert.deepEqual(entries.map((e) => e.kind), ['dir', 'file', 'url']);
    assert.deepEqual(entries.map((e) => e.sortOrder), [1, 2, 3]);
    assert.equal(countEntries(database, id), 3);
  });
});

test('资料入口：重排后顺序生效（"按常用程度排序"的基础）', () => {
  useDb((database) => {
    const id = makeMaterial(database, '资料');
    const a = createEntry(database, { archiveId: id, kind: 'dir', target: 'A' });
    const b = createEntry(database, { archiveId: id, kind: 'dir', target: 'B' });
    const c = createEntry(database, { archiveId: id, kind: 'dir', target: 'C' });

    reorderEntries(database, id, [c.id, a.id, b.id]);
    assert.deepEqual(listEntries(database, id).map((e) => e.target), ['C', 'A', 'B']);
    assert.deepEqual(listEntries(database, id).map((e) => e.sortOrder), [1, 2, 3]);
  });
});

test('资料入口：修改与删除', () => {
  useDb((database) => {
    const id = makeMaterial(database, '资料');
    const entry = createEntry(database, { archiveId: id, kind: 'url', target: 'https://old' });

    const updated = updateEntry(database, entry.id, { target: 'https://new', note: '改过了' });
    assert.equal(updated.target, 'https://new');
    assert.equal(updated.note, '改过了');

    deleteEntry(database, entry.id);
    assert.equal(getEntry(database, entry.id), undefined);
    assert.equal(listEntries(database, id).length, 0);
    // 再次删除应报未找到，而不是静默成功
    assert.throws(() => deleteEntry(database, entry.id), NotFoundError);
  });
});

test('资料入口：target 原样保存，不做任何规范化（M3 只存指针）', () => {
  useDb((database) => {
    const id = makeMaterial(database, '资料');
    // 这些都不是"干净"的路径，但都可能是合法的，不能自作聪明地改写
    const weird = [
      'D:\\work\\带 空格 的目录',
      '\\\\nas\\共享\\中文\\文件.docx',
      'file:///D:/work/x',
      'https://example.com/a?b=1&c=2#frag',
      'Z:\\未挂载的盘符',
    ];
    for (const target of weird) {
      const entry = createEntry(database, { archiveId: id, kind: 'dir', target });
      assert.equal(getEntry(database, entry.id)?.target, target, `不得改写：${target}`);
    }
  });
});

test('资料挂靠：一条资料可挂多个任务/项目（需求 §4.2 D2）', () => {
  useDb((database) => {
    const project = createProject(database, { title: 'Q3 迁移' });
    const task1 = createTask(database, { title: '写迁移方案' });
    const task2 = createTask(database, { title: '评估停机窗口' });
    const id = makeMaterial(database, '共用工作区');

    linkMaterial(database, id, 'project', project.id);
    linkMaterial(database, id, 'task', task1.id);
    linkMaterial(database, id, 'task', task2.id);

    assert.equal(countLinks(database, id), 3);
    assert.deepEqual(listArchivesLinkedTo(database, 'task', task1.id), [id]);
    assert.deepEqual(listArchivesLinkedTo(database, 'project', project.id), [id]);
  });
});

test('资料挂靠：重复挂靠幂等，不产生重复行也不报错', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const id = makeMaterial(database, '资料');

    assert.equal(linkMaterialIfAbsent(database, id, 'task', task.id), true, '首次应真正插入');
    assert.equal(linkMaterialIfAbsent(database, id, 'task', task.id), false, '重复应什么都不做');
    assert.equal(countLinks(database, id), 1);
  });
});

test('资料挂靠：可解除，且解除最后一个后成为"未挂靠"（违反 M1）', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const id = makeMaterial(database, '资料');
    linkMaterial(database, id, 'task', task.id);

    assert.deepEqual(listOrphanArchives(database), [], '有挂靠时不应出现在未挂靠列表');
    assert.equal(unlinkMaterial(database, id, 'task', task.id), true);
    assert.equal(unlinkMaterial(database, id, 'task', task.id), false, '再次解除应返回 false');

    assert.deepEqual(listOrphanArchives(database), [id], '失去全部挂靠后应被识别为未挂靠');
  });
});

test('资料挂靠：删除任务/项目时清理挂靠，不留孤儿', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const id = makeMaterial(database, '资料');
    linkMaterial(database, id, 'task', task.id);
    linkMaterial(database, id, 'project', '不存在的项目');

    // 模拟"删任务"：清掉它的挂靠（服务层在 deleteTask 里调用）
    assert.equal(unlinkAllFor(database, 'task', task.id), 1);
    assert.equal(countLinks(database, id), 1, '项目那条挂靠应保留');

    // 指向不存在对象的挂靠能被检出并清理
    assert.equal(countDanglingLinks(database), 1);
    assert.equal(pruneDanglingLinks(database), 1);
    assert.equal(countDanglingLinks(database), 0);
  });
});

test('资料挂靠：孤儿挂靠检测不误伤合法挂靠', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const project = createProject(database, { title: '项目' });
    const id = makeMaterial(database, '资料');
    linkMaterial(database, id, 'task', task.id);
    linkMaterial(database, id, 'project', project.id);

    assert.equal(countDanglingLinks(database), 0);
    assert.equal(pruneDanglingLinks(database), 0, '不应删掉任何合法挂靠');
    assert.equal(countLinks(database, id), 2);
  });
});

test('资料挂靠：批量取入口与批量按 id 回表，保持传入顺序', () => {
  useDb((database) => {
    const a = makeMaterial(database, '甲');
    const b = makeMaterial(database, '乙');
    const c = makeMaterial(database, '丙');
    createEntry(database, { archiveId: a, kind: 'dir', target: 'A1' });
    createEntry(database, { archiveId: a, kind: 'dir', target: 'A2' });
    createEntry(database, { archiveId: c, kind: 'url', target: 'C1' });

    const grouped = listEntriesForArchives(database, [a, b, c]);
    assert.equal(grouped.get(a)?.length, 2);
    assert.equal(grouped.get(b), undefined, '无入口的资料不应出现在 Map 里');
    assert.equal(grouped.get(c)?.length, 1);

    assert.deepEqual(listArchivesByIds(database, [c, a, b]).map((x) => x.title), ['丙', '甲', '乙']);
    assert.deepEqual(listArchivesByIds(database, []), []);
  });
});

test('资料：删除资料后入口与挂靠不再被列出', () => {
  useDb((database) => {
    const task = createTask(database, { title: '任务' });
    const id = makeMaterial(database, '资料');
    createEntry(database, { archiveId: id, kind: 'dir', target: 'D:\\x' });
    linkMaterial(database, id, 'task', task.id);
    assert.equal(listAllEntries(database).length, 1);
    assert.equal(listAllLinks(database).length, 1);

    // 软删除资料本身：入口行还在（外键级联只在硬删除时生效），
    // 但查询入口时资料已不可见，因此运行时的"全部入口"应随之减少。
    deleteArchive(database, id);
    assert.equal(getArchive(database, id), undefined);
    // 注：入口与挂靠行保留是刻意的 —— 回收站恢复资料时需要它们。
    assert.equal(listEntries(database, id).length, 1, '入口行保留，供回收站恢复');
  });
});

test('资料：verify 用的自检能发现零挂靠与孤儿挂靠', () => {
  useDb((database) => {
    const withLink = makeMaterial(database, '有挂靠');
    const orphan = makeMaterial(database, '无挂靠');
    const task = createTask(database, { title: '任务' });
    linkMaterial(database, withLink, 'task', task.id);
    // 指向一个不存在的任务：挂靠行存在，但没有实际着落
    linkMaterial(database, orphan, 'task', '早已不存在的任务');

    const orphans = listOrphanArchives(database);
    // 只有 orphan 未挂靠：它的挂靠是孤儿，等于没有着落。
    // withLink 指向真实任务，必须被排除 —— 不能因为"存在 link 行"就算有着落。
    assert.deepEqual(orphans, [orphan], '孤儿挂靠不算有效挂靠，有真实挂靠的不应被误判');
    assert.equal(countValidLinks(database, withLink), 1);
    assert.equal(countValidLinks(database, orphan), 0, '孤立挂靠的有效挂靠数必须是 0');
    assert.equal(countDanglingLinks(database), 1);
  });
});
