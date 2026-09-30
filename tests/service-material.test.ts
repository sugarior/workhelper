// 资料服务的测试（需求 §4.1 的三条硬规则）。
//
// 重点在两条**必须被强制**的规则，而不是 CRUD 走通：
//   M1 资料必须挂靠 —— 创建时要求至少一个目标；解除到零挂靠要拒绝
//   M2 绝不自动关联"当前正在做的任务" —— 目标必须显式传入（本层没有"猜"的分支）
//   M3 只存指针 —— target 原样保存，不校验可达性
//
// 另外锁住"入口按顺序整体替换"这条实现细节：
// 它是"按常用程度排序"（需求 §4.2 D2）的落地方式，拼错了会静默丢入口。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import { createMaterialService } from '../src/core/service/materialService.ts';
import { createCaptureService } from '../src/core/service/captureService.ts';
import { createPlanningService } from '../src/core/service/planningService.ts';
import { createTrackingService } from '../src/core/service/trackingService.ts';
import { createSearchService } from '../src/core/service/searchService.ts';
import { listEntries, countEntries, countValidLinks, listOrphanArchives } from '../src/core/repo/materialRepo.ts';
import { ValidationError, NotFoundError, InvalidTransitionError } from '../src/core/domain/errors.ts';

const DIR = 'D:\\work\\q3-migration';
const FILE = '\\\\nas\\设计\\迁移方案_v3.docx';
const URL = 'https://xxx.feishu.cn/docx/abc';

test('资料：创建时带入口与挂靠，读回来结构完整', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '写迁移方案' });

    const material = materials.create({
      title: 'Q3 迁移的工作区',
      entries: [
        { kind: 'dir', target: DIR, note: '工作区' },
        { kind: 'file', target: FILE, note: '最新方案' },
        { kind: 'url', target: URL },
      ],
      targets: [{ type: 'task', id: task.id }],
    });

    assert.equal(material.title, 'Q3 迁移的工作区');
    assert.deepEqual(material.entries.map((e) => e.kind), ['dir', 'file', 'url']);
    assert.deepEqual(material.entries.map((e) => e.note), ['工作区', '最新方案', null]);
    assert.deepEqual(material.links.map((l) => `${l.type}:${l.title}`), [`task:写迁移方案`]);
    assert.equal(materials.get(material.id).entries.length, 3);
  });
});

test('M1：没有挂靠就不允许创建（不可能顺手建一条没着落的资料）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    assert.throws(
      () => materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [] }),
      /必须挂靠到至少一个任务或项目/,
    );
    assert.equal(materials.list().length, 0, '拒绝后不应留下半成品');
  });
});

test('M1：一个入口都没有也不允许创建（否则它就不是指针了）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    assert.throws(
      () => materials.create({ entries: [], targets: [{ type: 'task', id: task.id }] }),
      /至少要有一个入口/,
    );
  });
});

test('M1：挂靠到不存在的任务会被拒绝，且不留下半成品', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    assert.throws(
      () => materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: 'nope' }] }),
      NotFoundError,
    );
    assert.equal(materials.list().length, 0);
  });
});

test('M1：拒绝把资料解除到零挂靠', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '唯一挂靠' });
    const material = materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: task.id }] });

    assert.throws(
      () => materials.unlink(material.id, { type: 'task', id: task.id }),
      /这是它最后一个挂靠/,
    );
    assert.equal(countValidLinks(database, material.id), 1, '拒绝后挂靠必须还在');
  });
});

test('M1：有两个挂靠时，解除其中一个可以', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const a = planning.createTask({ title: '甲' });
    const b = planning.createTask({ title: '乙' });
    const material = materials.create({
      entries: [{ kind: 'dir', target: DIR }],
      targets: [{ type: 'task', id: a.id }, { type: 'task', id: b.id }],
    });

    const after = materials.unlink(material.id, { type: 'task', id: a.id });
    assert.deepEqual(after.links.map((l) => l.title), ['乙']);
  });
});

test('一条资料可挂靠多个任务/项目，且标题能解析出来', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const project = planning.createProject({ title: 'Q3 迁移' });
    const task = planning.createTask({ title: '写方案' });

    const material = materials.create({
      entries: [{ kind: 'dir', target: DIR }],
      targets: [{ type: 'project', id: project.id }, { type: 'task', id: task.id }],
    });
    assert.deepEqual(material.links.map((l) => l.title).sort(), ['Q3 迁移', '写方案'].sort());
    // 反查：任务上挂着哪些资料
    assert.deepEqual(materials.listForTarget('task', task.id).map((m) => m.id), [material.id]);
    assert.deepEqual(materials.listForTarget('project', project.id).map((m) => m.id), [material.id]);
  });
});

test('M3：target 原样保存，不做规范化也不校验可达性', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });

    const weird = [
      { kind: 'dir', target: 'Z:\\未挂载的盘符' },
      { kind: 'dir', target: '\\\\nas\\共享\\中文\\目录' },
      { kind: 'url', target: 'https://example.com/a?b=1&c=2#frag' },
      { kind: 'file', target: 'D:\\带 空格 的目录\\文件.docx' },
    ];
    const material = materials.create({ entries: weird, targets: [{ type: 'task', id: task.id }] });
    assert.deepEqual(material.entries.map((e) => e.target), weird.map((w) => w.target));
  });
});

test('入口：更新时按顺序整体替换，多出的删掉、缺少的补上', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({
      entries: [
        { kind: 'dir', target: 'A' },
        { kind: 'dir', target: 'B' },
        { kind: 'dir', target: 'C' },
      ],
      targets: [{ type: 'task', id: task.id }],
    });

    // 换成两条：A 保留但换了内容，B 变成新的一条，C 应被删除
    const updated = materials.update(material.id, {
      entries: [
        { kind: 'file', target: 'A2', note: '改过了' },
        { kind: 'url', target: 'https://b.example.com' },
      ],
    });

    assert.deepEqual(updated.entries.map((e) => `${e.kind}:${e.target}`), ['file:A2', 'url:https://b.example.com']);
    assert.equal(countEntries(database, material.id), 2, '多出的入口必须被删掉，不能残留');
    assert.deepEqual(updated.entries.map((e) => e.sortOrder), [1, 2], '顺序即数组顺序');
  });
});

test('入口：把顺序倒过来会生效（"按常用程度排序"的基础）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({
      entries: [{ kind: 'dir', target: 'A' }, { kind: 'dir', target: 'B' }, { kind: 'dir', target: 'C' }],
      targets: [{ type: 'task', id: task.id }],
    });

    materials.update(material.id, {
      entries: [
        { kind: 'dir', target: 'C' },
        { kind: 'dir', target: 'B' },
        { kind: 'dir', target: 'A' },
      ],
    });
    assert.deepEqual(listEntries(database, material.id).map((e) => e.target), ['C', 'B', 'A']);
  });
});

test('入口：不允许清空（更新成空数组要报错，且原入口不被破坏）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({ entries: [{ kind: 'dir', target: 'A' }], targets: [{ type: 'task', id: task.id }] });

    assert.throws(() => materials.update(material.id, { entries: [] }), /至少要有一个入口/);
    assert.equal(countEntries(database, material.id), 1, '报错后原入口必须完好');
  });
});

test('挂靠：可以追加（幂等），也可以整体替换', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const project = planning.createProject({ title: '项目' });
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: task.id }] });

    assert.equal(materials.link(material.id, [{ type: 'project', id: project.id }]).links.length, 2);
    assert.equal(materials.link(material.id, [{ type: 'project', id: project.id }]).links.length, 2, '重复追加是幂等的');

    const replaced = materials.update(material.id, { targets: [{ type: 'project', id: project.id }] });
    assert.deepEqual(replaced.links.map((l) => l.title), ['项目'], '整体替换后只剩新的那个');
  });
});

test('挂靠：替换成空数组要报错（M1 不能绕过 update 绕过去）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: task.id }] });
    assert.throws(() => materials.update(material.id, { targets: [] }), /必须挂靠到至少一个/);
  });
});

test('未挂靠筛选：正常创建的资料不会出现在里面', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: task.id }] });

    assert.deepEqual(listOrphanArchives(database), []);
    assert.deepEqual(materials.list({ orphanOnly: true }), []);
    assert.equal(materials.list().length, 1);
  });
});

test('删除：软删除后读不到，也不再出现在列表里', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: task.id }] });

    materials.remove(material.id);
    assert.throws(() => materials.get(material.id), NotFoundError);
    assert.deepEqual(materials.list(), []);
    // 任务上的资料列表也应为空
    assert.deepEqual(materials.listForTarget('task', task.id), []);
  });
});

test('删除：软删除资料时，入口一并软删除（否则它仍被算作有效内容）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({
      entries: [{ kind: 'dir', target: DIR }, { kind: 'url', target: URL }],
      targets: [{ type: 'task', id: task.id }],
    });
    assert.equal(listEntries(database, material.id).length, 2);

    materials.remove(material.id);
    assert.deepEqual(listEntries(database, material.id), [], '入口必须跟着消失');
  });
});

test('有效挂靠：指向已删除任务的挂靠不算数（资料应被算作未挂靠）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '会被删掉的任务' });
    const material = materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: task.id }] });
    assert.deepEqual(listOrphanArchives(database), [], '一开始有着落');

    // 软删除任务：挂靠行还在（软删除不删行），但目标不再活动
    planning.deleteTask(task.id);
    // 关键：判定必须自己带 deleted_at 条件，不能依赖"删除时顺手清理"——
    // 否则资料会看起来有着落，点进去什么都没有
    assert.equal(countValidLinks(database, material.id), 0);
    assert.deepEqual(listOrphanArchives(database), [material.id], '应被算作未挂靠，好让资料页能处理它');
  });
});

test('撤销转出：资料被撤销后，任务上的资料列表里不能还留着它', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const capture = createCaptureService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '挂靠目标' });

    const { item } = capture.quickCapture({ text: DIR });
    const result = capture.classify(item.id, { kind: 'archive', links: [{ type: 'task', id: task.id }] });
    assert.equal(materials.listForTarget('task', task.id).length, 1);

    capture.undoLastClassification();
    // 只查挂靠表会返回已删除资料的行，于是任务详情里会出现一条点不开的资料
    assert.deepEqual(materials.listForTarget('task', task.id), []);
  });
});

test('M2：目标必须显式传入 —— 服务层不会猜"你正在做的那个"', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const focused = planning.createTask({ title: '我正在做的' });
    tracking.focusTask(focused.id);

    // 即使库里有焦点任务，不传目标依然必须失败 —— 这就是 M2
    assert.throws(
      () => materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [] }),
      /必须挂靠到至少一个/,
    );
    // 传了别的目标就挂到别的目标上，绝不"顺手"挂到焦点任务
    const other = planning.createTask({ title: '另一件' });
    const material = materials.create({ entries: [{ kind: 'dir', target: DIR }], targets: [{ type: 'task', id: other.id }] });
    assert.deepEqual(material.links.map((l) => l.title), ['另一件']);
  });
});

test('搜索：资料的入口路径与注释都能被搜到（需求 F-15）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const search = createSearchService(database);
    const task = planning.createTask({ title: '任务' });
    materials.create({
      title: 'Q3 工作区',
      entries: [
        { kind: 'dir', target: DIR, note: '迁移用的目录' },
        { kind: 'url', target: URL },
      ],
      targets: [{ type: 'task', id: task.id }],
    });

    for (const [query, why] of [['q3-migration', '路径'], ['迁移用的目录', '入口注释'], ['feishu', '网址']]) {
      const hits = search.search(query);
      assert.ok(hits.some((h) => h.entityType === 'archive'), `「${query}」（${why}）应该能搜到资料`);
    }
  });
});

test('入口来源：create 之后 entryTargets 与写入一致（供界面多选打开）', () => {
  useDb((database) => {
    const materials = createMaterialService(database);
    const planning = createPlanningService(database);
    const task = planning.createTask({ title: '任务' });
    const material = materials.create({
      entries: [{ kind: 'dir', target: DIR }, { kind: 'url', target: URL }],
      targets: [{ type: 'task', id: task.id }],
    });
    assert.deepEqual(materials.entryTargets(material.id), [DIR, URL]);
  });
});
