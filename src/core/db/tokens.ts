// 中文检索的 bigram 折叠。
//
// 背景（已实测，见 docs/design.md §6.5）：SQLite 的 unicode61 分词器把连续中文
// 当作单个 token，"接口文档" 与 "文档" 都查不到。把文本折叠成相邻双字后写入
// FTS5 的 tokens 列，即可让中文子串检索走倒排索引。
//
// 例：'整理Q3数据平台迁移方案' -> 'q3 整理 数据 据平 平台 台迁 迁移 移方 方案'

const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;
const ASCII_WORD = /[A-Za-z0-9_]+/g;

/** 把任意文本折叠成 FTS5 可正确切分的检索串 */
export function toTokens(text: string): string {
  const parts: string[] = [];

  for (const matched of text.matchAll(ASCII_WORD)) {
    parts.push(matched[0].toLowerCase());
  }

  for (const matched of text.matchAll(CJK_RUN)) {
    const run = matched[0];
    if (run.length === 1) {
      parts.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      parts.push(run.slice(i, i + 2));
    }
  }

  return parts.join(' ');
}

/** 折叠后的查询是否可用 FTS5（单字查询无法命中 bigram，需退化到 LIKE） */
export function isFtsQueryUsable(text: string): boolean {
  const tokens = toTokens(text).trim();
  return tokens.length > 0 && !(tokens.length === 1 && /[\u4e00-\u9fff]/.test(tokens));
}

/**
 * 把折叠后的查询串成 FTS5 的列限定短语匹配。
 * 双引号内的内容被视为短语，因此需转义内部的引号。
 */
export function buildFtsMatch(query: string): string | null {
  if (!isFtsQueryUsable(query)) return null;
  const tokens = toTokens(query).trim();
  if (tokens.length === 0) return null;
  const escaped = tokens.replaceAll('"', '""');
  return `tokens : "${escaped}"`;
}
