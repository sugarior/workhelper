// 迁移与结构约束测试。
// 验证 docs/design.md §4.4 的 DDL 在真实 SQLite 上的行为，
// 尤其是 CHECK、外键级联、部分索引这三类"写错了也不会立刻报错"的约束。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, closeDatabase, queryOne } from '../src/core/db/connection.ts';
import { migrate, currentVersion, listMigrations, assertSchemaVersionInSync, SCHEMA_VERSION } from '../src/core/db/index.ts';
import { withTx, inTransaction } from '../src/core/db/tx.ts';
import { MigrationError } from '../src/core/domain/errors.ts';

function freshDb() {
  const database = openDatabase(':memory:');
  migrate(database);
  return database;
}

const NOW = '2026-09-30T02:00:00.000Z';

test('迁移能建起全部表', () => {
  const database = freshDb();
  try {
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((row) => row.name);
    for (const expected of [
      'projects', 'inbox_items', 'tasks', 'subtasks', 'progress_entries',
      'daily_logs', 'archive_items', 'attachments', 'settings', 'search_fts',
    ]) {
      assert.ok(names.includes(expected), `缺少表 ${expected}`);
    }
    assert.equal(currentVersion(database), SCHEMA_VERSION);
  } finally {
    closeDatabase(database);
  }
});

test('迁移是幂等的：重复执行不产生额外变更', () => {
  const database = freshDb();
  try {
    const second = migrate(database);
    assert.deepEqual(second.applied, [], '第二次不应再应用任何迁移');
    assert.equal(second.from, SCHEMA_VERSION);
    assert.equal(second.to, SCHEMA_VERSION);
  } finally {
    closeDatabase(database);
  }
});

test('对文件库重复迁移同样幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-migrate-'));
  const dbPath = join(dir, 'workhelper.db');
  try {
    const first = openDatabase(dbPath);
    const firstResult = migrate(first);
    closeDatabase(first);

    const second = openDatabase(dbPath);
    const secondResult = migrate(second);
    const journal = second.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    closeDatabase(second);

    assert.ok(firstResult.applied.length > 0, '首次应应用迁移');
    assert.deepEqual(secondResult.applied, [], '再次打开不应重复应用');
    assert.equal(journal.journal_mode, 'wal', 'WAL 应为持久设置');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移文件列表连续且命名合规', () => {
  const files = listMigrations();
  assert.ok(files.length >= 1);
  files.forEach((file, index) => assert.equal(file.version, index + 1, `第 ${index + 1} 个迁移序号不连续`));
});

test('迁移数量与 SCHEMA_VERSION 保持一致', () => {
  // 防止新增迁移文件却忘记更新 SCHEMA_VERSION，导致升级判断错位
  assert.equal(assertSchemaVersionInSync(), SCHEMA_VERSION);
  assert.equal(listMigrations().length, SCHEMA_VERSION);
});

test('外键约束已开启', () => {
  const database = freshDb();
  try {
    const row = queryOne<{ foreign_keys: number }>(database, 'PRAGMA foreign_keys');
    assert.equal(Number(row?.foreign_keys), 1);
  } finally {
    closeDatabase(database);
  }
});

test('进展记录必须恰好挂一个父对象', () => {
  const database = freshDb();
  try {
    const insert = database.prepare(
      `INSERT INTO progress_entries
         (id, project_id, task_id, subtask_id, body, day_key, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    assert.throws(
      () => insert.run('p-none', null, null, null, '无归属', '2026-09-30', NOW, NOW, NOW),
      /CHECK constraint failed/i,
      '三列全空必须被拒绝',
    );

    database.prepare('INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('prj-1', '项目', NOW, NOW);
    database.prepare('INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('tsk-1', '任务', NOW, NOW);

    assert.throws(
      () => insert.run('p-both', 'prj-1', 'tsk-1', null, '挂两个', '2026-09-30', NOW, NOW, NOW),
      /CHECK constraint failed/i,
      '挂两个父对象必须被拒绝',
    );

    insert.run('p-one', null, 'tsk-1', null, '只挂任务', '2026-09-30', NOW, NOW, NOW);
    const count = queryOne<{ c: number }>(database, 'SELECT COUNT(*) AS c FROM progress_entries');
    assert.equal(Number(count?.c), 1, '恰好挂一个应被接受');
  } finally {
    closeDatabase(database);
  }
});

test('枚举取值受 CHECK 约束保护', () => {
  const database = freshDb();
  try {
    assert.throws(
      () => database.prepare('INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('t1', '任务', 'finished', NOW, NOW),
      /CHECK constraint failed/i,
      '非法任务状态必须被拒绝',
    );
    assert.throws(
      () => database.prepare('INSERT INTO projects (id, title, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('p1', '项目', 'urgent', NOW, NOW),
      /CHECK constraint failed/i,
      '非法优先级必须被拒绝',
    );
    assert.throws(
      () => database.prepare('INSERT INTO progress_entries (id, task_id, kind, body, day_key, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('g1', 't1', 'idea', '正文', '2026-09-30', NOW, NOW, NOW),
      /CHECK constraint failed/i,
      '非法进展类型必须被拒绝',
    );
  } finally {
    closeDatabase(database);
  }
});

test('删除任务会级联删除其子任务与进展记录', () => {
  const database = freshDb();
  try {
    database.prepare('INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('tsk-1', '任务', NOW, NOW);
    database.prepare('INSERT INTO subtasks (id, task_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('sub-1', 'tsk-1', '子任务', NOW, NOW);
    database.prepare(
      `INSERT INTO progress_entries (id, task_id, body, day_key, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('prg-1', 'tsk-1', '推进', '2026-09-30', NOW, NOW, NOW);

    database.prepare('DELETE FROM tasks WHERE id = ?').run('tsk-1');

    assert.equal(Number(queryOne<{ c: number }>(database, 'SELECT COUNT(*) AS c FROM subtasks')?.c), 0);
    assert.equal(Number(queryOne<{ c: number }>(database, 'SELECT COUNT(*) AS c FROM progress_entries')?.c), 0);
  } finally {
    closeDatabase(database);
  }
});

test('删除项目只解除任务归属，不删除任务', () => {
  const database = freshDb();
  try {
    database.prepare('INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('prj-1', '项目', NOW, NOW);
    database.prepare('INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('tsk-1', 'prj-1', '任务', NOW, NOW);

    database.prepare('DELETE FROM projects WHERE id = ?').run('prj-1');

    const task = queryOne<{ project_id: string | null }>(database, 'SELECT project_id FROM tasks WHERE id = ?', 'tsk-1');
    assert.equal(task?.project_id, null, '任务应保留且失去项目归属');
  } finally {
    closeDatabase(database);
  }
});

test('每天只能有一条未删除的日志（部分唯一索引）', () => {
  const database = freshDb();
  try {
    const now = '2026-09-30T02:00:00.000Z';
    const insert = database.prepare('INSERT INTO daily_logs (id, day_key, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('log-1', '2026-09-30', '今天', now, now);
    assert.throws(() => insert.run('log-2', '2026-09-30', '重复', now, now), /UNIQUE constraint failed/i);
  } finally {
    closeDatabase(database);
  }
});

test('软删除的日志不再占用当天：删除后可以重新创建', () => {
  const database = freshDb();
  try {
    const now = '2026-09-30T02:00:00.000Z';
    database
      .prepare('INSERT INTO daily_logs (id, day_key, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('log-1', '2026-09-30', '初稿', now, now);
    database.prepare('UPDATE daily_logs SET deleted_at = ? WHERE id = ?').run(now, 'log-1');

    // 关键：day_key 的唯一性只约束"未删除"的行，否则删掉当天日志后就再也写不回来
    database
      .prepare('INSERT INTO daily_logs (id, day_key, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('log-2', '2026-09-30', '重新写', now, now);

    const live = database
      .prepare('SELECT COUNT(*) AS c FROM daily_logs WHERE deleted_at IS NULL')
      .get() as { c: number };
    assert.equal(Number(live.c), 1);
    const all = database.prepare('SELECT COUNT(*) AS c FROM daily_logs').get() as { c: number };
    assert.equal(Number(all.c), 2, '旧行仍在（软删除），只是不再占用当天');
  } finally {
    closeDatabase(database);
  }
});

test('全文检索表可用并接受 bigram 折叠串', () => {
  const database = freshDb();
  try {
    const insert = database.prepare(
      'INSERT INTO search_fts (doc_id, entity_type, entity_id, title, body, tokens) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('task:tsk-1', 'task', 'tsk-1', '接口文档给张三', '', '接口 口文 文档 档给 给张 张三');

    const hits = database
      .prepare("SELECT entity_id FROM search_fts WHERE search_fts MATCH ?")
      .all('tokens : "文档"') as { entity_id: string }[];
    assert.deepEqual(hits.map((row) => row.entity_id), ['tsk-1'], '中文子串应能命中');
  } finally {
    closeDatabase(database);
  }
});

test('事务提交与回滚', () => {
  const database = freshDb();
  try {
    assert.equal(inTransaction(), false, '未开事务时状态应为 false');
    withTx(database, () => {
      assert.equal(inTransaction(), true, '事务内状态应为 true');
      database.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('k1', '"v1"', NOW);
    });
    assert.equal(inTransaction(), false, '事务结束后状态应复位');
    assert.equal(
      queryOne<{ value: string }>(database, 'SELECT value FROM settings WHERE key = ?', 'k1')?.value,
      '"v1"',
    );

    assert.throws(() => {
      withTx(database, () => {
        database.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('k2', '"v2"', NOW);
        throw new Error('故意失败');
      });
    }, /故意失败/);

    assert.equal(
      queryOne<{ c: number }>(database, 'SELECT COUNT(*) AS c FROM settings WHERE key = ?', 'k2')?.c,
      0,
      '事务回滚后不应留下记录',
    );
    assert.equal(inTransaction(), false, '回滚后状态应复位');
  } finally {
    closeDatabase(database);
  }
});

test('嵌套事务被明确拒绝', () => {
  const database = freshDb();
  try {
    assert.throws(
      () => {
        withTx(database, () => {
          withTx(database, () => undefined);
        });
      },
      /嵌套事务/,
    );
  } finally {
    closeDatabase(database);
  }
});

test('结构版本高于代码支持时拒绝继续', () => {
  const database = freshDb();
  try {
    database.exec('PRAGMA user_version = 99');
    assert.throws(() => migrate(database), MigrationError);
  } finally {
    closeDatabase(database);
  }
});
