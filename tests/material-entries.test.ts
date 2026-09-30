// 资料入口识别的测试（需求 F-13 / §4.2 D4）。
//
// 这里的**反例比正例重要**：识别错的代价是用户粘贴的内容被拆成了奇怪的入口，
// 而"识别不出"的代价只是它留在收件箱里当普通条目 —— 后者可接受，前者不可接受。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, looksLikeEntry, classifyLine } from '../src/core/material/entries.ts';

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

test('文字入口：识别不出路径/链接的行成为 text 入口，而不是被丢掉', () => {
  // 用户指出的真实场景（S5）：任务的资料里既要能放模板文件，
  // 也要能写"纸质原件在哪"。后者指向实物，属于指针信息，不违反 M3。
  const text = [
    'D:\\work\\proj',
    '今天开了个会，决定先做订单库',
    '\\\\\\\\nas\\share',
    '记得问一下法务',
  ].join('\n');

  const { entries, leftovers } = parseEntries(text);
  assert.deepEqual(entries.map((e) => `${e.kind}:${e.target}`), [
    'dir:D:\\work\\proj',
    'text:今天开了个会，决定先做订单库',
    'dir:\\\\\\\\nas\\share',
    'text:记得问一下法务',
  ]);
  assert.deepEqual(leftovers, [], '不再有"被丢掉的行"');
});

test('文字入口：一行一个入口的规则没有例外', () => {
  const { entries } = parseEntries('纸质原件在左抽屉第二格');
  assert.deepEqual(entries, [{ kind: 'text', target: '纸质原件在左抽屉第二格', note: null }]);
});

test('不猜：裸文件名与裸域名不会被当成可打开之物（而是文字入口）', () => {
  // 裸文件名与裸域名太容易是普通文字，因此不猜成 file/url；
  // 但它们也不会被丢掉 —— 成为 text 入口
  const { entries } = parseEntries(['方案.docx', 'example.com', '见附件三'].join('\n'));
  assert.deepEqual(entries.map((e) => e.kind), ['text', 'text', 'text']);
  assert.deepEqual(entries.map((e) => e.target), ['方案.docx', 'example.com', '见附件三']);
});

test('不猜：单独的盘符与分隔符也不算可打开之物', () => {
  const { entries } = parseEntries(['D:\\', '//'].join('\n'));
  assert.deepEqual(entries.map((e) => e.kind), ['text', 'text']);
});

test('空行被跳过，不产生空入口', () => {
  const { entries, leftovers } = parseEntries('\n\nD:\\work\\proj\n\n\n');
  assert.equal(entries.length, 1);
  assert.deepEqual(leftovers, []);
});

test('全是普通文字时，它们全都是文字入口（速记板不会丢内容）', () => {
  const { entries } = parseEntries('随口记一句');
  assert.deepEqual(entries, [{ kind: 'text', target: '随口记一句', note: null }]);
});

test('classifyLine 与 parseEntries 口径一致', () => {
  for (const line of ['D:\\work\\proj', 'https://a.com/b', '随口记一句', '方案.docx', '']) {
    const parsed = parseEntries(line);
    const one = classifyLine(line);
    assert.deepEqual(
      parsed.entries,
      one === null ? [] : [one],
      `「${line}」的口径必须一致`,
    );
  }
});

test('looksLikeEntry 只对"可打开之物"为真（文字入口不算）', () => {
  assert.equal(looksLikeEntry('D:\\work\\proj'), true);
  assert.equal(looksLikeEntry('https://a.com/b'), true);
  assert.equal(looksLikeEntry('随口记一句'), false, '文字入口不能"打开"，所以不算');
  assert.equal(looksLikeEntry(''), false);
});
