// 捕获与规划服务测试。
// 重点：快记通路不失败、日期解析与标题剥离、分类与撤销、
// 状态机在服务层生效（绕过界面也无法写入非法状态）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import { createCaptureService, canUndoClassification } from '../src/core/service/captureService.ts';
import { createPlanningService } from '../src/core/service/planningService.ts';
import { createTrackingService } from '../src/core/service/trackingService.ts';
import { createMaterialService } from '../src/core/service/materialService.ts';
import { listOrphanArchives } from '../src/core/repo/materialRepo.ts';
import { createSearchService } from '../src/core/service/searchService.ts';
import { createTask, getTask, listTasks } from '../src/core/repo/taskRepo.ts';
import { listProjects } from '../src/core/repo/projectRepo.ts';
import { listSubtasks } from '../src/core/repo/subtaskRepo.ts';
import { listArchives } from '../src/core/repo/archiveRepo.ts';
import { listEntries, listArchivesLinkedTo } from '../src/core/repo/materialRepo.ts';
import { getInboxItem } from '../src/core/repo/inboxRepo.ts';
import { InvalidTransitionError, ValidationError } from '../src/core/domain/errors.ts';

test('快记：解析出日期时剥离标题并保留原文', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const { item, parsed } = capture.quickCapture({ text: '接口文档 下周三 给张三' });

    assert.equal(parsed?.dayKey.length, 10, '应解析出日期');
    assert.equal(item.body.includes('下周三'), false, '标题里不应残留日期片段');
    assert.match(item.body, /接口文档/);
    assert.match(item.body, /张三/);
    assert.equal(item.rawInput, '接口文档 下周三 给张三', '原文必须保留，便于回溯');
    assert.equal(item.parsedDue, parsed?.dayKey);
  });
});

test('快记：解析不到日期时原样保存，不产生 rawInput', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const { item, parsed } = capture.quickCapture({ text: '整理Q3数据平台迁移方案' });
    assert.equal(parsed, null);
    assert.equal(item.body, '整理Q3数据平台迁移方案');
    assert.equal(item.rawInput, null);
    assert.equal(item.parsedDue, null);
  });
});

test('快记：空白输入被拒绝，不产生空条目', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    // 原先这条断言的是"空白也能存"，理由是"不能出现按了回车却没存"。
    // 那个理由把两件事混为一谈了：
    //   · 有内容 → 必须存（哪怕手滑多按了回车）
    //   · 什么都没有 → 不该产生条目（空条目在收件箱里就是垃圾，且没有可转出的内容）
    // 空条目还有实际危害：它没有任何可作为资料的内容（见 classify→archive 的校验）。
    assert.throws(() => capture.quickCapture({ text: '   ' }), /没有可记的内容/);
    assert.equal(capture.countPending(), 0);
  });
});

test('快记：只有换行/制表符也算空', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    assert.throws(() => capture.quickCapture({ text: '\n' }), /没有可记的内容/);
    assert.throws(() => capture.quickCapture({ text: '\t \r\n ' }), /没有可记的内容/);
    assert.equal(capture.countPending(), 0);
  });
});

test('快记：有内容但两端是空白时，仍然保存', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    // 「手滑多按了回车」的情形必须照存 —— 这才是原来那条测试想守的东西
    const { item } = capture.quickCapture({ text: '  真的要记的事  \n\n' });
    assert.equal(item.status, 'pending');
    assert.equal(item.body, '真的要记的事');
    assert.equal(capture.countPending(), 1);
  });
});

test('快记：连续记录顺序稳定，最新的在前', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    capture.quickCapture({ text: '第一条' });
    capture.quickCapture({ text: '第二条' });
    capture.quickCapture({ text: '第三条' });
    assert.deepEqual(capture.listPending().map((item) => item.body), ['第三条', '第二条', '第一条']);
    assert.equal(capture.countPending(), 3);
  });
});

test('分类为任务：携带来源、解析出的截止日与优先级', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const planning = createPlanningService(database);
    const { item } = capture.quickCapture({ text: '交接口文档 下周三' });

    const result = capture.classify(item.id, { kind: 'task', priority: 'high' });
    assert.equal(result.createdKind, 'task');

    const task = getTask(database, result.createdId);
    assert.equal(task?.sourceInboxId, item.id);
    assert.equal(task?.priority, 'high');
    assert.equal(task?.dueDate, item.parsedDue, '应沿用解析出的截止日');
    assert.equal(getInboxItem(database, item.id)?.status, 'converted');
    assert.equal(getInboxItem(database, item.id)?.convertedTo, `task:${result.createdId}`);
    assert.equal(planning.listProjects().length, 0);
  });
});

test('分类为资料 / 忽略', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '写迁移方案' });
    // 资料是指针：正文里要有可识别的路径或链接（需求 F-12 / M3）
    const asArchive = capture.quickCapture({ text: 'D:\\work\\q3-migration  工作区' }).item;
    const asDiscard = capture.quickCapture({ text: '垃圾信息' }).item;

    const archiveResult = capture.classify(asArchive.id, {
      kind: 'archive',
      archiveKind: 'meeting',
      links: [{ type: 'task', id: task.id }],
    });
    assert.equal(archiveResult.createdKind, 'archive');
    assert.equal(listArchives(database)[0]?.kind, 'meeting');
    // 入口必须真的落库（从正文解析出来的）
    assert.deepEqual(listEntries(database, archiveResult.createdId).map((e) => e.target), ['D:\\work\\q3-migration']);
    assert.deepEqual(listArchivesLinkedTo(database, 'task', task.id), [archiveResult.createdId]);

    const discardResult = capture.classify(asDiscard.id, { kind: 'discard' });
    assert.equal(discardResult.createdKind, 'inbox');
    assert.equal(getInboxItem(database, asDiscard.id)?.status, 'archived');
    assert.equal(capture.countPending(), 0);
  });
});

test('分类为资料：不选目标必须被拒绝（规则 M2 的落点）', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: 'D:\\work\\proj' }).item;

    // 这就是"绝不自动关联当前正在做的任务"在行为上的体现：
    // 没有目标就提交不了，服务层没有"猜一个目标"的分支
    assert.throws(
      () => capture.classify(item.id, { kind: 'archive' }),
      /必须选一个任务或项目/,
    );
    assert.equal(getInboxItem(database, item.id)?.status, 'pending', '被拒绝后条目必须还在');
    assert.equal(listArchives(database).length, 0, '不应留下半成品');
  });
});

test('项目列表：归档的项目默认不出现，但能显式找回（与任务的「中止」对称）', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const aktif = planning.createProject({ title: '在做的' });
    const archived = planning.createProject({ title: '不做了的' });
    planning.updateProject(archived.id, { status: 'archived' });

    const byDefault = planning.listProjects();
    assert.deepEqual(byDefault.map((p) => p.title), ['在做的'], '默认只列活动项目');
    assert.ok(!byDefault.some((p) => p.id === archived.id));

    // 「显示已归档」开关走这条路
    const withArchived = planning.listProjects({ includeArchived: true });
    assert.equal(withArchived.length, 2, 'includeArchived 要能找回它们，否则归档等于一去不返');

    // 显式按状态过滤仍然有效
    assert.deepEqual(planning.listProjects({ status: 'archived' }).map((p) => p.id), [archived.id]);
    assert.deepEqual(planning.listProjects({ status: 'active' }).map((p) => p.id), [aktif.id]);
  });
});

test('项目归档：不删除任何东西 —— 任务、进展、挂靠的资料都保留', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const materials = createMaterialService(database);

    const project = planning.createProject({ title: '会被归档的项目' });
    const task = planning.createTask({ title: '项目下的任务', projectId: project.id });
    tracking.addProgress({ target: { kind: 'project', id: project.id }, kind: 'progress', body: '做了一些' });
    const material = materials.create({
      entries: [{ kind: 'dir', target: 'D:\\work\\proj' }],
      targets: [{ type: 'project', id: project.id }],
    });

    planning.updateProject(project.id, { status: 'archived' });

    // 归档不是删除：这些都是"历史价值"，正是文档要求保留的东西
    assert.equal(listTasks(database).length, 1, '任务必须保留');
    assert.equal(getTask(database, task.id)?.projectId, project.id, '归属不能被解除');
    assert.equal(tracking.taskTimeline(task.id).length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM progress_entries WHERE project_id = ?').get(project.id).c, 1, '项目进展必须保留');
    // 挂靠仍然有效：归档不是删除，资料不会变成孤儿
    assert.deepEqual(materials.listForTarget('project', project.id).map((m) => m.id), [material.id]);
    assert.deepEqual(listOrphanArchives(database), [], '归档项目不该让它的资料变成孤儿');
  });
});

test('分类为资料：纯文字也能成为资料（指向实物，不违反 M3）', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '报销' });
    // 用户指出的真实场景（S5）：资料里要能写"纸质原件在哪"。
    // M3 禁止的是存文件字节，不是禁止文字成为资料。
    const item = capture.quickCapture({ text: '纸质原件在左抽屉第二格' }).item;

    const result = capture.classify(item.id, { kind: 'archive', links: [{ type: 'task', id: task.id }] });
    const entries = listEntries(database, result.createdId);
    assert.deepEqual(entries.map((e) => `${e.kind}:${e.target}`), ['text:纸质原件在左抽屉第二格']);
    assert.deepEqual(listArchivesLinkedTo(database, 'task', task.id), [result.createdId]);
  });
});

test('分类为资料：混合内容一行一个入口，文字行不再被丢掉', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '报销' });
    const item = capture.quickCapture({
      text: [
        'D:\\财务\\报销单模板.xlsx  模板',
        '纸质原件在左抽屉第二格',
        'https://xxx.feishu.cn/docx/abc',
      ].join('\n'),
      kindHint: 'note',
    }).item;

    const result = capture.classify(item.id, { kind: 'archive', links: [{ type: 'task', id: task.id }] });
    assert.deepEqual(listEntries(database, result.createdId).map((e) => e.kind), ['file', 'text', 'url']);
  });
});

test('分类为项目：碎片直接成为新项目，不产生任务', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    // 这一条本质就是"一件事"，而不是一件可独立交付的工作单元
    const item = capture.quickCapture({ text: 'Q3 数据平台迁移' }).item;

    const result = capture.classify(item.id, { kind: 'project', goal: '把订单库迁到新集群' });
    assert.equal(result.createdKind, 'project');

    const projects = listProjects(database);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.title, 'Q3 数据平台迁移');
    assert.equal(projects[0]?.goal, '把订单库迁到新集群');

    // 关键：项目是空容器，后续在项目页里逐步加任务与子任务
    assert.equal(listTasks(database).length, 0, '转项目不应顺带造出任务');
    assert.equal(listSubtasks(database, 'whatever').length, 0);
    assert.equal(getInboxItem(database, item.id)?.status, 'converted');
    assert.equal(getInboxItem(database, item.id)?.convertedTo, `project:${projects[0]?.id}`);
    assert.equal(capture.countPending(), 0);
  });
});

test('分类为项目：不带目标描述也能转', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: '装修书房' }).item;
    capture.classify(item.id, { kind: 'project' });

    const projects = listProjects(database);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.goal, null);
  });
});

test('批量转项目：一次把多条碎片变成多个项目', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const ids = ['装修书房', '换车', '年度体检'].map((body) => capture.quickCapture({ text: body }).item.id);

    const results = capture.classifyMany(ids, { kind: 'project' });
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.createdKind), ['project', 'project', 'project']);
    assert.deepEqual(listProjects(database).map((p) => p.title).sort(), ['换车', '年度体检', '装修书房'].sort());
    assert.equal(capture.countPending(), 0);
  });
});

test('撤销：转项目后可整体撤销，项目消失且条目回到待处理', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: '需要立项的事' }).item;
    capture.classify(item.id, { kind: 'project' });
    assert.equal(listProjects(database).length, 1);
    assert.equal(canUndoClassification(database), true);

    assert.equal(capture.undoLastClassification(), true);
    assert.equal(listProjects(database).length, 0, '撤销应把新建项目从活动视图移除');
    assert.equal(getInboxItem(database, item.id)?.status, 'pending', '条目应回到待处理');
    assert.equal(getInboxItem(database, item.id)?.convertedTo, null, 'convertedTo 应被清掉');
    assert.equal(canUndoClassification(database), false, '不能重复撤销');
  });
});

test('撤销：混合批量（项目 + 任务 + 资料）能一次全部回退', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const planning = createPlanningService(database);
    const anchor = planning.createTask({ title: '挂靠目标' });
    const asProject = capture.quickCapture({ text: '该立项的' }).item.id;
    const asTask = capture.quickCapture({ text: '该做成任务的' }).item.id;
    // 资料要有可识别路径，并显式给挂靠目标（规则 M1/M2）
    const asArchive = capture.quickCapture({ text: 'D:\\work\\该留存的' }).item.id;

    capture.classify(asProject, { kind: 'project' });
    capture.classify(asTask, { kind: 'task' });
    capture.classify(asArchive, { kind: 'archive', links: [{ type: 'task', id: anchor.id }] });
    // 单条分类各自写撤销点，最后一次撤销只回退最后一条
    assert.equal(capture.undoLastClassification(), true);
    assert.equal(listArchives(database).length, 0);
    assert.equal(listProjects(database).length, 1, '项目不受最后一次撤销影响');
    assert.equal(listTasks(database).length, 2, '分类出的任务 + 挂靠用的锚点任务');
    assert.deepEqual(listArchivesLinkedTo(database, 'task', anchor.id), [], '挂靠要随资料一起回退');
  });
});

test('分类为项目：新项目立刻可搜（与任务、资料一致）', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const search = createSearchService(database);
    const item = capture.quickCapture({ text: '数据平台迁移' }).item;
    capture.classify(item.id, { kind: 'project' });

    const hits = search.search('数据平台');
    const projectHit = hits.find((hit) => hit.entityType === 'project');
    assert.ok(projectHit !== undefined, `新项目必须立刻能搜到，实际命中：${JSON.stringify(hits.map((h) => h.entityType))}`);
    assert.equal(projectHit.displayTitle, '数据平台迁移');
  });
});

test('批量分类：一次清空多条，只记一次撤销点', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const ids = ['甲', '乙', '丙'].map((body) => capture.quickCapture({ text: body }).item.id);

    const results = capture.classifyMany(ids, { kind: 'task' });
    assert.equal(results.length, 3);
    assert.equal(capture.countPending(), 0);
    assert.equal(listTasks(database).length, 3);

    assert.equal(capture.undoLastClassification(), true);
    assert.equal(capture.countPending(), 3, '三条应回到待处理');
    assert.equal(listTasks(database).length, 0, '撤销应把新建任务从活动视图移除');
  });
});

test('撤销：分类后可恢复，且不能重复撤销', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const { item } = capture.quickCapture({ text: '待分类' });
    assert.equal(capture.undoLastClassification(), false, '没有可撤销操作时应返回 false');

    capture.classify(item.id, { kind: 'task' });
    assert.equal(canUndoClassification(database), true);
    assert.equal(capture.undoLastClassification(), true);
    assert.equal(capture.undoLastClassification(), false, '第二次撤销应无事可做');

    const restored = getInboxItem(database, item.id);
    assert.equal(restored?.status, 'pending');
    assert.equal(restored?.convertedTo, null);
  });
});

test('分类：已处理条目不能重复分类', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const { item } = capture.quickCapture({ text: '只能分一次' });
    capture.classify(item.id, { kind: 'task' });
    assert.throws(() => capture.classify(item.id, { kind: 'task' }), InvalidTransitionError);
  });
});

test('分类：条目不存在时报错', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    assert.throws(() => capture.classify('nope', { kind: 'task' }), InvalidTransitionError);
  });
});

test('忽略：待处理的条目被忽略后不再待处理，数据仍在（可放回）', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: '我不要这条' }).item;
    assert.equal(capture.countPending(), 1);

    capture.ignoreItem(item.id);
    assert.equal(capture.countPending(), 0, '忽略后不再待处理');
    // 忽略不是删除：行还在，状态是 archived，因此能被"放回待处理"
    assert.equal(getInboxItem(database, item.id)?.status, 'archived');
    assert.equal(getInboxItem(database, item.id)?.deletedAt, null, '忽略不是删除');
    assert.notEqual(getInboxItem(database, item.id), undefined, '数据必须还在');
  });
});

test('忽略：可以作用于已转出的条目，且**不影响任务本身**', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: '这条已经转成任务了' }).item;
    const result = capture.classify(item.id, { kind: 'task' });
    assert.equal(listTasks(database).length, 1);

    // 这是"收件箱只保留一个动作"之后新增的能力：
    // 已转出的条目也能忽略 —— 那只是标记掉一行审计痕迹
    capture.ignoreItem(item.id);

    assert.equal(getInboxItem(database, item.id)?.status, 'archived');
    assert.equal(getInboxItem(database, item.id)?.convertedTo, `task:${result.createdId}`,
      'converted_to 必须保留，它是"这条转出过什么"的痕迹');
    assert.equal(listTasks(database).length, 1, '任务绝不能因为收件箱条目被忽略而消失');
    assert.equal(getTask(database, result.createdId)?.status, 'todo');
  });
});

test('忽略：幂等，重复点不报错', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: '重复忽略' }).item;
    capture.ignoreItem(item.id);
    assert.doesNotThrow(() => capture.ignoreItem(item.id));
    assert.equal(getInboxItem(database, item.id)?.status, 'archived');
  });
});

test('忽略：不存在的 id 报 NotFoundError', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    assert.throws(() => capture.ignoreItem('nope'), /收件箱条目不存在/);
  });
});

test('撤销：忽略待处理的条目后，撤销把它放回待处理', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: '忽略再撤销' }).item;
    capture.ignoreItem(item.id);
    assert.equal(capture.countPending(), 0);
    assert.equal(canUndoClassification(database), true);

    assert.equal(capture.undoLastClassification(), true);
    // 它当初是待处理的，因此回到待处理（而不是"已转出"）
    assert.equal(getInboxItem(database, item.id)?.status, 'pending');
    assert.equal(capture.countPending(), 1);
  });
});

test('撤销：忽略已转出的条目后，撤销把它还原成"已转出"而不是放回待处理', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const item = capture.quickCapture({ text: '转出后又被忽略' }).item;
    const result = capture.classify(item.id, { kind: 'task' });
    capture.ignoreItem(item.id);
    assert.equal(getInboxItem(database, item.id)?.status, 'archived');

    assert.equal(capture.undoLastClassification(), true);
    // 关键：它当初不是待处理的，撤销后也不该变成待处理 ——
    // 否则收件箱会凭空多出一条本该已处理的记录
    assert.equal(getInboxItem(database, item.id)?.status, 'converted');
    assert.equal(capture.countPending(), 0);
    // 忽略不影响任务，撤销忽略自然也不该动它
    assert.equal(getTask(database, result.createdId)?.status, 'todo');
  });
});

test('项目：创建后能取出完整树结构', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const project = planning.createProject({ title: 'Q3 数据平台迁移', goal: '完成迁移' });
    const task = planning.createTask({ title: '写迁移方案', projectId: project.id });
    planning.createSubtask({ taskId: task.id, title: '盘点现有表' });
    planning.createSubtask({ taskId: task.id, title: '评估停机窗口' });

    const tree = planning.projectTree(project.id);
    assert.equal(tree.project.title, 'Q3 数据平台迁移');
    assert.equal(tree.tasks.length, 1);
    assert.equal(tree.tasks[0]?.subtasks.length, 2);
    assert.deepEqual(tree.tasks[0]?.counts, { total: 2, done: 0 });
  });
});

test('项目：删除时解除任务归属但不隐藏任务', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const project = planning.createProject({ title: '项目' });
    const task = planning.createTask({ title: '任务', projectId: project.id });

    const result = planning.deleteProject(project.id);
    assert.equal(result.detachedTasks, 1);
    assert.equal(getTask(database, task.id)?.title, '任务', '任务必须仍在活动列表里');
    assert.equal(getTask(database, task.id)?.projectId, null);
    assert.equal(listTasks(database, { projectId: null }).length, 1);
  });
});

test('规划：任务状态流转受状态机约束', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });

    assert.equal(planning.setTaskStatus(task.id, 'doing').status, 'doing');
    assert.equal(planning.setTaskStatus(task.id, 'blocked', { blockedReason: '等法务' }).status, 'blocked');
    assert.throws(() => planning.setTaskStatus(task.id, 'done'), InvalidTransitionError, '阻塞不能直接完成');

    assert.equal(planning.setTaskStatus(task.id, 'doing').status, 'doing');
    const done = planning.completeTask(task.id);
    assert.equal(done.status, 'done');
    assert.ok(done.completedAt !== null, '完成任务必须写完成时间');
  });
});

test('规划：标记阻塞必须给原因', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    planning.setTaskStatus(task.id, 'doing');
    assert.throws(() => planning.setTaskStatus(task.id, 'blocked'), ValidationError);
    assert.throws(() => planning.setTaskStatus(task.id, 'blocked', { blockedReason: '  ' }), ValidationError);
  });
});

test('规划：直接改状态也走状态机，不能绕过', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    planning.setTaskStatus(task.id, 'done');
    assert.throws(() => planning.setTaskStatus(task.id, 'cancelled'), InvalidTransitionError);

    // 通过 updateTask 直接改状态同样受约束
    assert.throws(() => planning.updateTask(task.id, { status: 'blocked' }), InvalidTransitionError);
  });
});

test('规划：完成任务时只有显式要求才级联子任务', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    planning.createSubtask({ taskId: task.id, title: '步骤一' });
    planning.createSubtask({ taskId: task.id, title: '步骤二' });

    planning.completeTask(task.id);
    assert.equal(listSubtasks(database, task.id).filter((item) => item.status === 'todo').length, 2, '默认不动子任务');

    planning.reopenTask(task.id);
    planning.completeTask(task.id, { cascadeSubtasks: true });
    assert.equal(listSubtasks(database, task.id).filter((item) => item.status === 'done').length, 2);
  });
});

test('规划：子任务状态维护完成水印', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const subtask = planning.createSubtask({ taskId: task.id, title: '步骤' });

    const done = planning.setSubtaskStatus(subtask.id, 'done');
    assert.equal(done.status, 'done');
    assert.ok(done.completedAt !== null);

    const reopened = planning.setSubtaskStatus(subtask.id, 'todo');
    assert.equal(reopened.completedAt, null);
  });
});

test('规划：空标题被拒绝', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    assert.throws(() => planning.createProject({ title: '   ' }), ValidationError);
    assert.throws(() => planning.createTask({ title: '' }), ValidationError);
    const task = planning.createTask({ title: '任务' });
    assert.throws(() => planning.createSubtask({ taskId: task.id, title: ' ' }), ValidationError);
  });
});

test('规划：预估时长必须为正整数或留空', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    assert.throws(() => planning.createTask({ title: '任务', estimateMinutes: 0 }), ValidationError);
    assert.throws(() => planning.createTask({ title: '任务', estimateMinutes: -5 }), ValidationError);
    const ok = planning.createTask({ title: '任务', estimateMinutes: 30 });
    assert.equal(ok.estimateMinutes, 30);
  });
});

test('规划：拖拽排序三种层级都可用', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const project = planning.createProject({ title: '项目' });
    const taskA = planning.createTask({ title: 'A', projectId: project.id });
    const taskB = planning.createTask({ title: 'B', projectId: project.id });

    planning.reorder('task', taskB.id, taskA.id);
    assert.deepEqual(listTasks(database, { projectId: project.id }).map((item) => item.title), ['B', 'A']);

    const projectB = planning.createProject({ title: '项目B' });
    planning.reorder('project', projectB.id, project.id);
    assert.deepEqual(planning.listProjects().map((item) => item.title), ['项目B', '项目']);
  });
});

test('规划：索引随写入同步更新，改名后旧词不再命中新记录', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    planning.createTask({ title: '接口文档给张三' });
    const search = listTasks(database);
    assert.equal(search.length, 1);

    // 改名后索引应指向新标题
    planning.updateTask(search[0]!.id, { title: '数据平台迁移方案' });
    assert.equal(getTask(database, search[0]!.id)?.title, '数据平台迁移方案');
  });
});

test('规划：删任务会同时清掉索引', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '要删的任务' });
    planning.deleteTask(task.id);
    assert.equal(getTask(database, task.id), undefined);
    const left = database.prepare('SELECT COUNT(*) AS c FROM search_fts').get() as { c: number };
    assert.equal(Number(left.c), 0, '删除后索引应同步清理');
  });
});

test('规划：收件箱转来的任务保留来源，便于回溯', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const planning = createPlanningService(database);
    const { item } = capture.quickCapture({ text: '交接口文档' });

    const result = capture.classify(item.id, { kind: 'task' });
    const task = getTask(database, result.createdId);
    assert.equal(task?.sourceInboxId, item.id);
    assert.equal(planning.listProjects().length, 0);
    assert.ok(createTask(database, { title: '对照任务' }).id.length > 0);
  });
});
