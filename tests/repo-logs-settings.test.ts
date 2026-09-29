// 每日日志、设置、附件仓储测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers/db.ts';
import { saveDailyLog, getDailyLog, listDailyLogs, deleteDailyLog } from '../src/core/repo/dailyLogRepo.ts';
import {
  getSetting, setSetting, deleteSetting, listSettings,
  getDayBoundaryHour, setDayBoundaryHour, ensureSetting, SETTING_KEYS,
} from '../src/core/repo/settingsRepo.ts';
import {
  createAttachment, getAttachment, listAttachments, findByDigest, deleteAttachment,
} from '../src/core/repo/attachmentRepo.ts';
import { createArchive, deleteArchive } from '../src/core/repo/archiveRepo.ts';
import { ValidationError } from '../src/core/domain/errors.ts';

test('日志：一天一条，首次保存即创建', () => {
  useDb((database) => {
    assert.equal(getDailyLog(database, '2026-09-30'), undefined);
    const saved = saveDailyLog(database, '2026-09-30', '今天完成了接口文档');
    assert.equal(saved.dayKey, '2026-09-30');
    assert.equal(saved.body, '今天完成了接口文档');
  });
});

test('日志：重复保存是更新而不是新增', () => {
  useDb((database) => {
    const first = saveDailyLog(database, '2026-09-30', '初稿');
    const second = saveDailyLog(database, '2026-09-30', '改后的正文');
    assert.equal(second.id, first.id, '同一天应是同一条记录');
    assert.equal(getDailyLog(database, '2026-09-30')?.body, '改后的正文');
    assert.equal(listDailyLogs(database).length, 1);
  });
});

test('日志：可补录历史日期，列表按日期倒序', () => {
  useDb((database) => {
    saveDailyLog(database, '2026-09-28', '前天');
    saveDailyLog(database, '2026-09-30', '今天');
    saveDailyLog(database, '2026-09-29', '昨天');

    assert.deepEqual(listDailyLogs(database).map((log) => log.dayKey), ['2026-09-30', '2026-09-29', '2026-09-28']);
    assert.deepEqual(
      listDailyLogs(database, { from: '2026-09-29', to: '2026-09-30' }).map((log) => log.dayKey),
      ['2026-09-30', '2026-09-29'],
    );
  });
});

test('日志：删除后可重新创建', () => {
  useDb((database) => {
    saveDailyLog(database, '2026-09-30', '正文');
    deleteDailyLog(database, '2026-09-30');
    assert.equal(getDailyLog(database, '2026-09-30'), undefined);
    const recreated = saveDailyLog(database, '2026-09-30', '重新写');
    assert.equal(recreated.body, '重新写');
  });
});

test('设置：读写与 JSON 往返', () => {
  useDb((database) => {
    assert.equal(getSetting(database, 'missing', '兜底'), '兜底');
    setSetting(database, 'a.string', '文本');
    setSetting(database, 'a.number', 42);
    setSetting(database, 'a.object', { nested: [1, 2, 3] });

    assert.equal(getSetting(database, 'a.string', ''), '文本');
    assert.equal(getSetting(database, 'a.number', 0), 42);
    assert.deepEqual(getSetting(database, 'a.object', {}), { nested: [1, 2, 3] });

    setSetting(database, 'a.number', 43);
    assert.equal(getSetting(database, 'a.number', 0), 43, '重复写入应覆盖');

    deleteSetting(database, 'a.number');
    assert.equal(getSetting(database, 'a.number', 0), 0);

    const all = listSettings(database);
    assert.ok(all.some((entry) => entry.key === 'a.string'));
  });
});

test('设置：损坏的 JSON 回退到默认值而不是抛错', () => {
  useDb((database) => {
    database
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run('broken', '{不是合法 JSON', '2026-09-30T00:00:00.000Z');
    assert.equal(getSetting(database, 'broken', '兜底'), '兜底', '坏数据不应阻断启动');
  });
});

test('设置：日界小时默认 4，写入前校验范围', () => {
  useDb((database) => {
    assert.equal(getDayBoundaryHour(database), 4);
    setDayBoundaryHour(database, 0);
    assert.equal(getDayBoundaryHour(database), 0, '0 表示自然日切分');
    setDayBoundaryHour(database, 6);
    assert.equal(getDayBoundaryHour(database), 6);

    assert.throws(() => setDayBoundaryHour(database, 24), ValidationError);
    assert.throws(() => setDayBoundaryHour(database, -1), ValidationError);
    assert.throws(() => setDayBoundaryHour(database, 3.5), ValidationError);
  });
});

test('设置：越界的历史值读取时回退到默认', () => {
  useDb((database) => {
    setSetting(database, SETTING_KEYS.dayBoundaryHour, 99);
    assert.equal(getDayBoundaryHour(database), 4, '非法存量值应回退，而不是让日界算出错');
  });
});

test('设置：ensureSetting 只在缺失时写入', () => {
  useDb((database) => {
    ensureSetting(database, 'k', '初始');
    ensureSetting(database, 'k', '不该覆盖');
    assert.equal(getSetting(database, 'k', ''), '初始');
  });
});

test('附件：存元信息并通过摘要去重', () => {
  useDb((database) => {
    const archive = createArchive(database, { kind: 'file', title: '合同扫描件' });
    const first = createAttachment(database, {
      archiveId: archive.id,
      fileName: '合同.pdf',
      relPath: 'ab/cd/合同.pdf',
      byteSize: 2048,
      sha256: 'digest-1',
    });
    assert.equal(first.archiveId, archive.id);
    assert.equal(listAttachments(database, archive.id).length, 1);

    assert.equal(findByDigest(database, 'digest-1')?.id, first.id);
    assert.equal(findByDigest(database, 'other'), undefined, '同一份文件可被识别为已存在');
  });
});

test('附件：软删除父对象不级联，物理删除才级联', () => {
  useDb((database) => {
    const archive = createArchive(database, { kind: 'file', title: '资料' });
    const attachment = createAttachment(database, {
      archiveId: archive.id,
      fileName: 'a.txt',
      relPath: 'aa/a.txt',
      byteSize: 1,
      sha256: 'd',
    });

    // 软删除归档条目：附件行仍在（软删除不触发数据库级联），可随父对象一起恢复
    deleteArchive(database, archive.id);
    const survived = database
      .prepare('SELECT COUNT(*) AS c FROM attachments WHERE id = ?')
      .get(attachment.id) as { c: number };
    assert.equal(Number(survived.c), 1, '软删除父对象不应物理删除附件');

    // 物理删除归档条目：外键 ON DELETE CASCADE 生效
    database.prepare('DELETE FROM archive_items WHERE id = ?').run(archive.id);
    const gone = database
      .prepare('SELECT COUNT(*) AS c FROM attachments WHERE id = ?')
      .get(attachment.id) as { c: number };
    assert.equal(Number(gone.c), 0, '物理删除父对象应级联删除附件');

    assert.equal(getAttachment(database, attachment.id), undefined);
  });
});

test('附件：自身软删除后不再出现在列表中', () => {
  useDb((database) => {
    const archive = createArchive(database, { kind: 'file', title: '资料' });
    const attachment = createAttachment(database, {
      archiveId: archive.id,
      fileName: 'b.txt',
      relPath: 'bb/b.txt',
      byteSize: 2,
      sha256: 'e',
    });
    deleteAttachment(database, attachment.id);
    assert.equal(getAttachment(database, attachment.id), undefined);
    assert.equal(listAttachments(database, archive.id).length, 0);
  });
});
