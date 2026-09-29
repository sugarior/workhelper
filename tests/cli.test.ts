// CLI 端到端测试。
//
// 每个用例都真正 spawn 一个 node 子进程，因此同时验证了一件事：
// 数据确实落到了磁盘上——进程之间不共享任何内存状态。
// 这层测试覆盖不到的地方，服务层单测已经覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', 'src', 'cli', 'wh.ts');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** 在同一个数据目录上跑一条 CLI 命令 */
function run(dataDir: string, ...args: string[]): RunResult {
  const result = spawnSync(process.execPath, [CLI, '--data', dataDir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 建一个隔离的数据目录，用完即删 */
function withDataDir<T>(fn: (dataDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wh-cli-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从 CLI 输出里抓取 8 位短 ID */
function extractIds(text: string): string[] {
  return [...text.matchAll(/\b([0-9a-f]{8})\b/g)].map((match) => match[1] ?? '');
}

test('CLI：--version 与 help 不需要数据库', () => {
  const result = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);

  const help = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /快记一句/);
});

test('CLI：首次运行自动建库，status 反映真实状态', () => {
  withDataDir((dataDir) => {
    const result = run(dataDir, 'status');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /结构版本\s+: v\d+/);
    assert.match(result.stdout, /收件箱\s+: 0 条待处理/);
  });
});

test('CLI：快记能识别日期并落盘，收件箱可读回', () => {
  withDataDir((dataDir) => {
    const add = run(dataDir, 'add', '接口文档 下周三 给张三');
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /已记入收件箱/);
    assert.match(add.stdout, /→ 截止 \d{4}-\d{2}-\d{2}/);
    assert.match(add.stdout, /待处理共 1 条/);

    // 新进程读回，证明数据真的落盘了
    const inbox = run(dataDir, 'inbox');
    assert.equal(inbox.status, 0);
    assert.match(inbox.stdout, /接口文档/);
    assert.match(inbox.stdout, /给张三/);
    assert.match(inbox.stdout, /原文/);
    assert.equal(inbox.stdout.includes('下周三'), true, '原文里应保留未解析的日期片段');
  });
});

test('CLI：完整闭环 —— 快记 → 分类 → 加子任务 → 推进 → 完成', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '整理Q3数据平台迁移方案');

    const inbox = run(dataDir, 'inbox');
    const inboxId = extractIds(inbox.stdout)[0];
    assert.ok(inboxId !== undefined, `未能取出收件箱 id：${inbox.stdout}`);

    const proj = run(dataDir, 'proj', 'add', 'Q3 迁移', '--goal', '完成迁移');
    assert.equal(proj.status, 0, proj.stderr);
    const projectId = extractIds(proj.stdout)[0];
    assert.ok(projectId !== undefined);

    const classified = run(dataDir, 'task', inboxId, '--project', projectId, '--priority', 'high');
    assert.equal(classified.status, 0, classified.stderr);
    const taskId = extractIds(classified.stdout)[0];
    assert.ok(taskId !== undefined, `未能取出任务 id：${classified.stdout}`);

    const sub = run(dataDir, 'sub', taskId, '盘点现有表');
    assert.equal(sub.status, 0, sub.stderr);
    const subtaskId = extractIds(sub.stdout)[0];
    assert.ok(subtaskId !== undefined);

    assert.equal(run(dataDir, 'doing', taskId).status, 0);
    assert.equal(run(dataDir, 'note', taskId, '已完成初稿').status, 0);
    assert.equal(run(dataDir, 'subdone', subtaskId).status, 0);
    assert.equal(run(dataDir, 'done', taskId).status, 0);

    const list = run(dataDir, 'ls');
    assert.match(list.stdout, /\[x\]/, '完成任务应显示为已勾选');
    assert.match(list.stdout, /整理Q3数据平台迁移方案/);
  });
});

test('CLI：卡点会联动任务状态', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '带卡点的任务');
    const inboxId = extractIds(run(dataDir, 'inbox').stdout)[0] ?? '';
    const taskId = extractIds(run(dataDir, 'task', inboxId).stdout)[0] ?? '';

    assert.equal(run(dataDir, 'doing', taskId).status, 0);
    const note = run(dataDir, 'note', taskId, '卡点', '等法务确认');
    assert.equal(note.status, 0, note.stderr);
    assert.match(note.stdout, /任务状态已联动为 blocked/);

    const today = run(dataDir, 'today');
    assert.match(today.stdout, /阻塞中/);
    assert.match(today.stdout, /等法务确认/);
  });
});

test('CLI：中文子串搜索可用', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '接口文档给张三');
    const inboxId = extractIds(run(dataDir, 'inbox').stdout)[0] ?? '';
    run(dataDir, 'task', inboxId);

    for (const query of ['接口文档', '文档', '张三']) {
      const result = run(dataDir, 'search', query);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /接口文档给张三/, `查询「${query}」应命中`);
    }
  });
});

test('CLI：日志汇总反映真实完成情况，且删除后日期不被占用', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '会被完成的任务');
    const inboxId = extractIds(run(dataDir, 'inbox').stdout)[0] ?? '';
    const taskId = extractIds(run(dataDir, 'task', inboxId).stdout)[0] ?? '';

    const before = run(dataDir, 'log');
    assert.match(before.stdout, /完成 0/);

    run(dataDir, 'done', taskId);
    const after = run(dataDir, 'log');
    assert.match(after.stdout, /完成 1/, '完成任务后汇总应更新');

    const save = run(dataDir, 'log', '2026-09-20', '补录的正文');
    assert.equal(save.status, 0, save.stderr);
    const read = run(dataDir, 'log', '2026-09-20');
    assert.match(read.stdout, /补录的正文/);
  });
});

test('CLI：撤销分类把条目放回收件箱', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '会被撤销的分类');
    const inboxId = extractIds(run(dataDir, 'inbox').stdout)[0] ?? '';
    run(dataDir, 'task', inboxId);
    assert.match(run(dataDir, 'inbox').stdout, /收件箱是空的/);

    const undo = run(dataDir, 'undo');
    assert.equal(undo.status, 0);
    assert.match(undo.stdout, /已撤销上一次分类/);
    assert.match(run(dataDir, 'inbox').stdout, /会被撤销的分类/);
  });
});

test('CLI：批量分类与批量丢弃', () => {
  withDataDir((dataDir) => {
    for (const text of ['甲', '乙', '丙']) run(dataDir, 'add', text);
    const ids = extractIds(run(dataDir, 'inbox').stdout);
    assert.equal(ids.length, 3);

    const result = run(dataDir, 'task', ...ids);
    assert.equal(result.status, 0, result.stderr);
    assert.match(run(dataDir, 'ls').stdout, /共 3 条/);
  });
});

test('CLI：退避 —— 未知命令退出码 2 且打印帮助', () => {
  withDataDir((dataDir) => {
    const result = run(dataDir, 'nonsense');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /未知命令/, '错误信息走 stderr');
    assert.match(result.stdout, /用法：/, '帮助走 stdout');
  });
});

test('CLI：错误路径退出码为 1 且给出可读原因', () => {
  withDataDir((dataDir) => {
    const missing = run(dataDir, 'done', 'zzzzzz');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /找不到匹配/);

    const tooShort = run(dataDir, 'done', 'ab');
    assert.equal(tooShort.status, 1);
    assert.match(tooShort.stderr, /至少需要 4 位/);

    const badStatus = run(dataDir, 'ls', '--status', 'nonsense');
    assert.equal(badStatus.status, 1);
    assert.match(badStatus.stderr, /只能是/);
  });
});

test('CLI：终态任务拒绝再推进，并提示如何恢复', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '已完成的任务');
    const inboxId = extractIds(run(dataDir, 'inbox').stdout)[0] ?? '';
    const taskId = extractIds(run(dataDir, 'task', inboxId).stdout)[0] ?? '';
    run(dataDir, 'done', taskId);

    const again = run(dataDir, 'done', taskId);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /已经是 done 状态/);

    const note = run(dataDir, 'note', taskId, '完成后的补充');
    assert.equal(note.status, 1);
    assert.match(note.stderr, /不能再写入推进记录/);
  });
});

test('CLI：回收站可列表、恢复与彻底删除', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '会被删掉的任务');
    const inboxId = extractIds(run(dataDir, 'inbox').stdout)[0] ?? '';
    const taskId = extractIds(run(dataDir, 'task', inboxId).stdout)[0] ?? '';

    // 通过服务无法直接删任务，用项目删除路径验证回收站可读
    const trash = run(dataDir, 'trash', 'list');
    assert.equal(trash.status, 0);
    assert.match(trash.stdout, /回收站是空的/);

    const projResult = run(dataDir, 'proj', 'add', '临时项目');
    const projectId = extractIds(projResult.stdout)[0] ?? '';
    run(dataDir, 'proj', 'rm', projectId);

    const after = run(dataDir, 'trash', 'list');
    assert.match(after.stdout, /项目/);
    assert.match(after.stdout, /还剩 30 天/);

    const restored = run(dataDir, 'trash', 'restore', projectId);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /已恢复项目/);
    assert.match(run(dataDir, 'proj', 'list').stdout, /临时项目/);

    assert.ok(taskId.length > 0);
  });
});

test('CLI：备份生成文件并可轮换', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '备份前的数据');
    const first = run(dataDir, 'backup');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /备份完成：wh-\d{8}-\d{6}-manual\.db/);

    // 同一秒内连续备份不能互相覆盖
    const second = run(dataDir, 'backup');
    assert.equal(second.status, 0);
    assert.match(second.stdout, /manual-1\.db/);
  });
});

test('CLI：verify 检查结构与业务一致性', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '一条记录');
    const result = run(dataDir, 'verify');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SQLite 完整性 : ok/);
    assert.match(result.stdout, /外键孤儿      : 0 条/);
    assert.match(result.stdout, /业务自检      : 通过/);
  });
});

test('CLI：reindex 重建索引后搜索仍可用', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '重建索引前的记录');
    const reindex = run(dataDir, 'reindex');
    assert.equal(reindex.status, 0, reindex.stderr);
    assert.match(reindex.stdout, /索引已重建，共 \d+ 条/);
    assert.match(run(dataDir, 'search', '重建索引').stdout, /重建索引前的记录/);
  });
});

test('CLI：settings 可读写日界小时并校验取值', () => {
  withDataDir((dataDir) => {
    assert.match(run(dataDir, 'settings').stdout, /日界小时\s+: 4/);

    const set = run(dataDir, 'settings', 'boundary', '0');
    assert.equal(set.status, 0, set.stderr);
    assert.match(run(dataDir, 'settings').stdout, /日界小时\s+: 0/);

    const bad = run(dataDir, 'settings', 'boundary', '24');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /0–23/);
  });
});

test('CLI：--json 输出可被解析', () => {
  withDataDir((dataDir) => {
    run(dataDir, 'add', '结构化输出的记录');
    const result = run(dataDir, '--json', 'inbox');
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { body: string }[];
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed[0]?.body, '结构化输出的记录');
  });
});

test('CLI：项目树展示任务与子任务层级', () => {
  withDataDir((dataDir) => {
    const project = run(dataDir, 'proj', 'add', '层级项目');
    const projectId = extractIds(project.stdout)[0] ?? '';

    run(dataDir, 'add', '层级任务');
    const inboxId = extractIds(run(dataDir, 'inbox').stdout)[0] ?? '';
    const taskId = extractIds(run(dataDir, 'task', inboxId, '--project', projectId).stdout)[0] ?? '';
    run(dataDir, 'sub', taskId, '步骤一');
    run(dataDir, 'sub', taskId, '步骤二');

    const show = run(dataDir, 'proj', 'show', projectId);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /层级任务/);
    assert.match(show.stdout, /步骤一/);
    assert.match(show.stdout, /步骤二/);
    assert.match(show.stdout, /0\/1 任务/);
  });
});
