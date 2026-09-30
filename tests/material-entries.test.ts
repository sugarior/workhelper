// 资料入口识别的测试（需求 F-13 / §4.2 D4）。
//
// 这里的**反例比正例重要**：识别错的代价是用户粘贴的内容被拆成了奇怪的入口，
// 而"识别不出"的代价只是它留在收件箱里当普通条目 —— 后者可接受，前者不可接受。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, looksLikeEntry } from '../src/core/material/entries.ts';

test('识别：一行一个入口，行内其余文字成为该入口的注释', () => {
  const text = [
    'D:\\work\\q3-migration  工作区',
    '\\\\nas\\设计\\迁移方案_v3.docx  最新方案',
    'https://xxx.feishu.cn/docx/abc  立项会纪要',
  ].join('\n');

  const { entries, leftovers } = parseEntries(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { kind: 'dir', target: 'D:\\work\\q3-migration', note: '工作区' });
  assert.deepEqual(entries[1], { kind: 'file', target: '\\\\nas\\设计\\迁移方案_v3.docx', note: '最新方案' });
  assert.deepEqual(entries[2], { kind: 'url', target: 'https://xxx.feishu.cn/docx/abc', note: '立项会纪要' });
  assert.deepEqual(leftovers, []);
});

test('识别：注释在路径前后都能归属正确', () => {
  const { entries } = parseEntries('工作区在这里 D:\\work\\proj');
  assert.equal(entries[0]?.target, 'D:\\work\\proj');
  assert.equal(entries[0]?.note, '工作区在这里');
});

test('识别：只有路径、没有注释时 note 为 null', () => {
  const { entries } = parseEntries('D:\\work\\proj');
  assert.deepEqual(entries[0], { kind: 'dir', target: 'D:\\work\\proj', note: null });
});

test('识别：没有扩展名的末段按目录处理，有扩展名的按文件', () => {
  const { entries } = parseEntries([
    'D:\\work\\q3',
    'D:\\work\\方案.docx',
    'D:\\work\\q3\\',
    '/home/me/notes',
    '/home/me/notes.md',
  ].join('\n'));

  assert.deepEqual(entries.map((e) => `${e.kind}:${e.target}`), [
    'dir:D:\\work\\q3',
    'file:D:\\work\\方案.docx',
    'dir:D:\\work\\q3\\',
    'dir:/home/me/notes',
    'file:/home/me/notes.md',
  ]);
});

test('识别：URL 在行中间也能认出来', () => {
  const { entries } = parseEntries('看下 https://www.overleaf.com/latex/templates 这个模板');
  assert.equal(entries[0]?.kind, 'url');
  assert.equal(entries[0]?.target, 'https://www.overleaf.com/latex/templates');
  assert.equal(entries[0]?.note, '看下 这个模板');
});

test('识别：URL 优先于路径（file:// 这类既像又不像）', () => {
  const { entries } = parseEntries('file:///D:/work/proj');
  assert.equal(entries[0]?.kind, 'url', '带协议的一律按 URL 处理');
});

test('识别：去掉成对引号（资源管理器"复制为路径"会带引号）', () => {
  const { entries } = parseEntries('"D:\\work\\带 空格 的目录"');
  assert.equal(entries[0]?.target, 'D:\\work\\带 空格 的目录');
});

test('识别：去掉尾随的中文句读', () => {
  const { entries } = parseEntries('工作区是 D:\\work\\proj，别忘了');
  assert.equal(entries[0]?.target, 'D:\\work\\proj');
  assert.equal(entries[0]?.note, '工作区是 别忘了');
});

test('绝不丢内容：识别不出的行原样留在 leftovers', () => {
  const text = [
    'D:\\work\\proj',
    '今天开了个会，决定先做订单库',
    '\\\\\\\\nas\\share',
    '记得问一下法务',
  ].join('\n');

  const { entries, leftovers } = parseEntries(text);
  assert.deepEqual(entries.map((e) => e.target), ['D:\\work\\proj', '\\\\\\\\nas\\share']);
  assert.deepEqual(leftovers, ['今天开了个会，决定先做订单库', '记得问一下法务']);
});

test('不猜：裸文件名与裸域名都不算入口', () => {
  // 裸文件名（无分隔符）与裸域名太容易是普通文字，宁可留在 leftovers
  const { entries, leftovers } = parseEntries([
    '方案.docx',
    'example.com',
    '见附件三',
  ].join('\n'));
  assert.deepEqual(entries, [], '这三行都不该被当成入口');
  assert.equal(leftovers.length, 3, '它们必须原样保留，不能被丢掉');
});

test('不猜：单独的盘符或分隔符不算入口', () => {
  const { entries, leftovers } = parseEntries(['D:\\', '//'].join('\n'));
  assert.deepEqual(entries, [], '都不是入口');
  // 它们仍原样保留 —— 宁可留下两条没用的行，也不丢用户写的东西
  assert.deepEqual(leftovers, ['D:\\', '//']);
});

test('空行被跳过，不产生空入口也不进 leftovers', () => {
  const { entries, leftovers } = parseEntries('\n\nD:\\work\\proj\n\n\n');
  assert.equal(entries.length, 1);
  assert.deepEqual(leftovers, []);
});

test('全部是普通文字时一个入口都没有（速记板退化成普通收件箱）', () => {
  const { entries, leftovers } = parseEntries('随口记一句');
  assert.deepEqual(entries, []);
  assert.deepEqual(leftovers, ['随口记一句']);
});

test('looksLikeEntry 与 parseEntries 口径一致', () => {
  for (const line of ['D:\\work\\proj', 'https://a.com/b', '随口记一句', '方案.docx', '']) {
    const parsed = parseEntries(line);
    assert.equal(
      looksLikeEntry(line),
      parsed.entries.length === 1,
      `「${line}」的口径必须一致`,
    );
  }
});
