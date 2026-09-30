// 搜索与系统服务测试。
// 重点：搜索回源显示当前标题、索引重建；备份快照与轮换；
// 完整性自检能真的发现问题（而不是永远返回 ok）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeDb, useDb } from './helpers/db.ts';
import { createSearchService } from '../src/core/service/searchService.ts';
import { createSystemService, backupFileName, BACKUP_KEEP_DAILY } from '../src/core/service/systemService.ts';
import { createPlanningService } from '../src/core/service/planningService.ts';
import { createCaptureService } from '../src/core/service/captureService.ts';
import { createTrackingService } from '../src/core/service/trackingService.ts';
import { createJournalService } from '../src/core/service/journalService.ts';
import { closeDatabase } from '../src/core/db/connection.ts';
import { ValidationError } from '../src/core/domain/errors.ts';

test('搜索：分类产生的资料条目立刻可搜（F-11 要求搜资料全文）', () => {
  useDb((database) => {
    const capture = createCaptureService(database);
    const search = createSearchService(database);

    const { item } = capture.quickCapture({ text: '会议结论：需要补充附件三' });
    capture.classify(item.id, { kind: 'archive', archiveKind: 'meeting' });

    // 曾经漏接：资料只在 reindexAll() 时才进索引，分类后立刻搜是搜不到的。
    // 注意结果里还会有原始收件箱条目——快记时它已被索引且仍然存在（有意为之，
    // 便于按"下周三"这类被剥离的日期片段搜回原始输入），因此这里不假设只有一条。
    const hits = search.search('附件三');
    const archiveHit = hits.find((hit) => hit.entityType === 'archive');
    assert.ok(archiveHit !== undefined, `刚归档的资料必须立刻能搜到，实际命中：${JSON.stringify(hits.map((h) => h.entityType))}`);
    assert.equal(archiveHit.entityLabel, '资料');
    assert.equal(archiveHit.alive, true);
    assert.match(archiveHit.displayTitle, /附件三/);
  });
});

test('搜索：日志正文可搜（F-11 要求搜日志全文）', () => {
  useDb((database) => {
    const journal = createJournalService(database);
    const search = createSearchService(database);

    assert.equal(search.search('阻断项').length, 0, '保存前搜不到');
    journal.save('2026-09-30', '今天的阻断项是等法务确认合同条款');

    const hits = search.search('阻断项');
    assert.equal(hits.length, 1, '刚保存的日志必须立刻能搜到');
    assert.equal(hits[0]?.entityType, 'log');
  });
});

test('搜索：日志被删除后索引同步清理', () => {
  useDb((database) => {
    const journal = createJournalService(database);
    const search = createSearchService(database);

    journal.save('2026-09-30', '会被删掉的日志内容');
    assert.equal(search.search('会被删掉').length, 1);

    journal.delete('2026-09-30');
    assert.equal(search.search('会被删掉').length, 0, '删除日志后不应还能搜到');
  });
});

test('搜索：索引失败不影响业务写入（横切关注点不得阻断主流程）', () => {
  useDb((database) => {
    const journal = createJournalService(database);
    // 让索引写入必然失败：把 FTS 虚拟表换成一张形状不对的普通表
    database.exec('DROP TABLE search_fts');
    database.exec('CREATE TABLE search_fts (doc_id TEXT)');

    const saved = journal.save('2026-09-30', '索引坏掉时正文仍必须保存成功');
    assert.equal(saved.body, '索引坏掉时正文仍必须保存成功');
    assert.equal(journal.get('2026-09-30')?.body, '索引坏掉时正文仍必须保存成功');
  });
});

test('搜索：命中任务并回源当前标题', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const search = createSearchService(database);
    planning.createTask({ title: '接口文档给张三' });

    const hits = search.search('文档');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.entityType, 'task');
    assert.equal(hits[0]?.displayTitle, '接口文档给张三');
    assert.equal(hits[0]?.alive, true);
    assert.equal(hits[0]?.entityLabel, '任务');
  });
});

test('搜索：改名后按新词命中，旧词不再命中', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const search = createSearchService(database);
    const task = planning.createTask({ title: '接口文档给张三' });
    planning.updateTask(task.id, { title: '数据平台迁移方案' });

    assert.equal(search.search('接口文档').length, 0, '旧索引应已被替换');
    assert.equal(search.search('数据平台').length, 1);
    assert.equal(search.search('数据平台')[0]?.displayTitle, '数据平台迁移方案');
  });
});

test('搜索：已删除的实体即使索引残留也标记为不存活', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const search = createSearchService(database);
    const task = planning.createTask({ title: '会被删掉的任务' });

    // 绕过服务直接写索引，模拟索引滞后
    search.indexEntity({ entityType: 'task', entityId: task.id, title: '会被删掉的任务', body: '' });
    planning.deleteTask(task.id);

    const hits = search.search('会被删掉');
    assert.equal(hits.length, 0, '服务层删除会同步清索引');
  });
});

test('搜索：索引滞后时展示回源标题，不显示过期文本', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const search = createSearchService(database);
    const task = planning.createTask({ title: '当前标题' });

    // 手工塞一条过期索引（标题与实体不一致）
    search.removeEntity('task', task.id);
    database
      .prepare(
        `INSERT INTO search_fts (rowid, doc_id, entity_type, entity_id, title, body, tokens)
         VALUES (?, ?, 'task', ?, ?, '', '过期 期标 标题')`,
      )
      .run(999999, `task:${task.id}`, task.id, '过期标题');

    const hits = search.search('过期标题');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.displayTitle, '当前标题', '展示必须回源，而不是用过期的索引文本');
  });
});

test('搜索：跨实体类型命中并按优先级排序', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const capture = createCaptureService(database);
    const search = createSearchService(database);

    planning.createProject({ title: '合同条款确认项目' });
    planning.createTask({ title: '合同条款确认' });
    capture.quickCapture({ text: '合同条款待确认' });

    const types = search.search('合同条款').map((hit) => hit.entityType);
    assert.equal(types[0], 'task', '任务优先');
    assert.ok(types.includes('project'));
    assert.ok(types.includes('inbox'));
  });
});

test('搜索：重建索引可恢复全部内容', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const capture = createCaptureService(database);
    const search = createSearchService(database);

    const task = planning.createTask({ title: '迁移方案编写' });
    tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '已完成初稿' });
    capture.quickCapture({ text: '散落的碎片想法' });

    const count = search.reindexAll();
    assert.ok(count >= 3, `重建应覆盖任务/进展/收件箱，实际 ${count}`);
    assert.equal(search.search('迁移方案').length, 1);
    assert.equal(search.search('初稿').length, 1);
    assert.equal(search.search('碎片想法').length, 1);
  });
});

test('搜索：空查询返回空数组', () => {
  useDb((database) => {
    const search = createSearchService(database);
    assert.deepEqual(search.search(''), []);
    assert.deepEqual(search.search('   '), []);
  });
});

test('备份文件名格式可被解析回来', () => {
  const at = new Date(2026, 8, 30, 14, 5, 9);
  assert.equal(backupFileName(at, 'daily'), 'wh-20260930-140509-daily.db');
  assert.equal(backupFileName(at, 'weekly'), 'wh-20260930-140509-weekly.db');
  assert.equal(backupFileName(at, 'manual'), 'wh-20260930-140509-manual.db');
});

test('系统：备份生成真实文件且可被识别', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-backup-'));
  const database = makeDb();
  try {
    const planning = createPlanningService(database);
    planning.createTask({ title: '要被备份的任务' });

    const system = createSystemService(database, join(dir, 'backups'));
    const file = await system.backup('manual');

    assert.ok(file.byteSize > 0, '备份文件不应为空');
    assert.equal(file.kind, 'manual');
    assert.equal(file.fileName.endsWith('-manual.db'), true);

    const listed = system.listBackups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.fileName, file.fileName);

    // 备份是完整可读的数据库：单独打开它应能看到刚才的数据
    const restored = new (await import('node:sqlite')).DatabaseSync(file.path, { readOnly: true });
    const row = restored.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    restored.close();
    assert.equal(Number(row.c), 1, '快照内容应与源库一致');
  } finally {
    closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('系统：轮换只保留最近 7 个日快照，手动快照不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-rotate-'));
  const database = makeDb();
  try {
    const backupDir = join(dir, 'backups');
    const system = createSystemService(database, backupDir);

    for (let i = 0; i < BACKUP_KEEP_DAILY + 3; i += 1) {
      await system.backup('daily');
    }
    await system.backup('manual');
    assert.equal(system.listBackups().length, BACKUP_KEEP_DAILY + 4);

    const removed = system.rotateBackups();
    assert.equal(removed.length, 3, '应删掉 3 个多余的日快照');

    const left = system.listBackups();
    assert.equal(left.filter((file) => file.kind === 'daily').length, BACKUP_KEEP_DAILY);
    assert.equal(left.filter((file) => file.kind === 'manual').length, 1, '手动快照不参与轮换');
  } finally {
    closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('系统：目录不存在时 listBackups 返回空而不是抛错', () => {
  const database = makeDb();
  try {
    const system = createSystemService(database, join(tmpdir(), 'wh-nonexistent-dir-xyz', 'backups'));
    assert.deepEqual(system.listBackups(), []);
    assert.deepEqual(system.rotateBackups(), []);
  } finally {
    closeDatabase(database);
  }
});

test('系统：完整性自检在干净库上通过', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const tracking = createTrackingService(database);
    const system = createSystemService(database, join(tmpdir(), 'wh-check'));

    const task = planning.createTask({ title: '正常任务' });
    planning.setTaskStatus(task.id, 'doing');
    tracking.addProgress({ target: { kind: 'task', id: task.id }, kind: 'progress', body: '正常推进' });

    const report = system.integrityCheck();
    assert.equal(report.sqliteIntegrity, 'ok');
    assert.equal(report.foreignKeyOrphans, 0);
    assert.deepEqual(report.issues, []);
    assert.equal(report.ok, true);
  });
});

test('系统：完整性自检能发现"阻塞但无原因"这类业务问题', () => {
  useDb((database) => {
    const system = createSystemService(database, join(tmpdir(), 'wh-check2'));
    // 绕过服务规则，直接写坏数据，验证自检真的能查出来
    database
      .prepare(
        `INSERT INTO tasks (id, title, status, blocked_reason, created_at, updated_at)
         VALUES ('bad', '卡住但没写原因', 'blocked', NULL, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`,
      )
      .run();

    const report = system.integrityCheck();
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.includes('阻塞')), `问题列表应包含阻塞项：${report.issues.join('; ')}`);
  });
});

test('系统：完整性自检能发现"已完成但无完成时间"', () => {
  useDb((database) => {
    const system = createSystemService(database, join(tmpdir(), 'wh-check3'));
    database
      .prepare(
        `INSERT INTO tasks (id, title, status, completed_at, created_at, updated_at)
         VALUES ('bad2', '完成但没时间', 'done', NULL, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`,
      )
      .run();

    const report = system.integrityCheck();
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.includes('完成时间')));
  });
});

test('系统：回收站能力经服务层可用', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const system = createSystemService(database, join(tmpdir(), 'wh-trash'));

    const task = planning.createTask({ title: '误删任务' });
    planning.deleteTask(task.id);

    assert.equal(system.trash.count(), 1);
    assert.equal(system.trash.list()[0]?.title, '误删任务');
    assert.equal(system.trash.retentionDays, 30);

    system.trash.restore('task', task.id);
    assert.equal(system.trash.count(), 0);
    assert.equal(planning.listProjects().length, 0);
  });
});

test('系统：设置读写与日界校验', () => {
  useDb((database) => {
    const system = createSystemService(database, join(tmpdir(), 'wh-settings'));

    assert.equal(system.settings.dayBoundaryHour(), 4, '默认凌晨 4 点切日');
    system.settings.setDayBoundaryHour(6);
    assert.equal(system.settings.dayBoundaryHour(), 6);
    assert.throws(() => system.settings.setDayBoundaryHour(24), ValidationError);

    system.settings.set('ai.model', 'deepseek-chat');
    assert.equal(system.settings.get('ai.model', ''), 'deepseek-chat');
    assert.ok(system.settings.list().some((entry) => entry.key === 'ai.model'));
  });
});

test('系统：逐条彻底删除与到期清理', () => {
  useDb((database) => {
    const planning = createPlanningService(database);
    const system = createSystemService(database, join(tmpdir(), 'wh-purge'));

    const first = planning.createTask({ title: '彻底删' });
    const second = planning.createTask({ title: '留着' });
    planning.deleteTask(first.id);
    planning.deleteTask(second.id);

    system.trash.purgeOne('task', first.id);
    assert.equal(system.trash.count(), 1);

    // 把剩下那条的删除时间改到 40 天前，验证到期清理
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    database.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(old, second.id);

    const purged = system.trash.purgeExpired();
    assert.equal(purged.task, 1);
    assert.equal(system.trash.count(), 0);
  });
});
