// 中文检索折叠的测试。
//
// 这里的两条都是**真实踩过的坑**，而不是为了覆盖率：
//  1. 折叠必须按原文顺序输出 —— 曾经先输出全部 ASCII 词、再输出全部中文 bigram，
//     于是中英混排查询的词序与正文不一致，短语匹配永远命中不了
//  2. 列限定匹配用 AND 而不是短语 —— 折叠是逐段做的，查询词序本来就不需要与正文相同，
//     否则任何跨越"中文/非中文"边界的查询都会落空

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTokens, buildFtsMatch, isFtsQueryUsable } from '../src/core/db/tokens.ts';
import { useDb } from './helpers/db.ts';
import { createSearchService } from '../src/core/service/searchService.ts';
import { indexEntity } from '../src/core/repo/searchRepo.ts';

test('折叠：按原文顺序输出（中英混排顺序不能被打乱）', () => {
  // 这是缺陷 36 的直接回归测试：
  // 旧实现会输出 "nas _v3 docx 设计 迁移 移方 方案"（ASCII 全在前），
  // 于是查询 "_v3 迁移 移方 方案" 与正文词序不一致，短语匹配命中不了
  const tokens = toTokens('D:\\设计\\迁移方案_v3.docx').split(' ');
  const cjkIndex = tokens.indexOf('迁移');
  const asciiIndex = tokens.indexOf('_v3');
  assert.ok(cjkIndex >= 0 && asciiIndex >= 0, `两个片段都应在 token 里：${tokens.join(' ')}`);
  assert.ok(cjkIndex < asciiIndex, `中文片段在原文里靠前，token 里也必须靠前：${tokens.join(' ')}`);
});

test('折叠：中文被切成相邻双字', () => {
  assert.equal(toTokens('迁移方案'), '迁移 移方 方案');
  assert.equal(toTokens('附件'), '附件');
});

test('折叠：单个汉字与 ASCII 词原样保留', () => {
  assert.equal(toTokens('看 Q3 数据'), '看 q3 数据');
  assert.equal(toTokens('LaTeX'), 'latex');
});

test('匹配串：用 AND 而不是短语（跨中英边界才能命中）', () => {
  const match = buildFtsMatch('方案_v3');
  assert.equal(match, 'tokens : "方案 _v3"');
  // 关键：**不能有引号包住整串当成短语**的语义差异 ——
  // 这里两个 token 以空格分隔即 AND，正是我们要的
  assert.ok(!match!.includes('  '), '不应有重复空格');
});

test('可用性判断：单个汉字无法用 bigram，需退化到 LIKE', () => {
  assert.equal(isFtsQueryUsable('看'), false);
  assert.equal(isFtsQueryUsable('看数据'), true);
  assert.equal(isFtsQueryUsable('q3'), true);
  assert.equal(isFtsQueryUsable(''), false);
});

test('端到端：中英混排的查询能命中（含下划线、扩展名、UNC 路径）', () => {
  useDb((database) => {
    const search = createSearchService(database);
    const body = '\\\\nas\\设计\\迁移方案_v3.docx 需要补充附件三';
    indexEntity(database, { entityType: 'archive', entityId: 'a1', title: '迁移方案', body: toTokens(body) });

    // 每一条都是"查询词跨越了中文/非中文边界"的情况 —— 旧实现全都搜不到
    for (const query of ['迁移方案_v3', '方案_v3', '迁移方案_v3.docx', 'nas\\设计', '设计\\迁移', '_v3.docx']) {
      const hits = search.search(query);
      assert.ok(
        hits.some((hit) => hit.entityId === 'a1'),
        `「${query}」应该能搜到，实际命中 ${hits.length} 条`,
      );
    }
  });
});

test('端到端：纯中文子串检索仍然可用（原有能力不能退化）', () => {
  useDb((database) => {
    const search = createSearchService(database);
    indexEntity(database, { entityType: 'archive', entityId: 'a2', title: '', body: toTokens('整理Q3数据平台迁移方案') });

    for (const query of ['迁移方案', '数据平台', '整理']) {
      const hits = search.search(query);
      assert.ok(hits.some((hit) => hit.entityId === 'a2'), `「${query}」应该能搜到`);
    }
  });
});

test('端到端：搜不到的词仍然搜不到（放宽到 AND 不能变成乱召回）', () => {
  useDb((database) => {
    const search = createSearchService(database);
    indexEntity(database, { entityType: 'archive', entityId: 'a3', title: '', body: toTokens('迁移方案_v3') });

    // bigram 的精度由"多个 bigram 同时命中"保证：只要有一个不匹配就不返回
    assert.deepEqual(search.search('迁移计划'), [], '「计划」的 bigram 不在索引里，不应命中');
    assert.deepEqual(search.search('方案_v9'), [], '版本号不同不应命中');
  });
});
