// 中文检索的 bigram 折叠。
//
// 背景（已实测，见 docs/design.md §6.5）：SQLite 的 unicode61 分词器把连续中文
// 当作单个 token，"接口文档" 与 "文档" 都查不到。把文本折叠成相邻双字后写入
// FTS5 的 tokens 列，即可让中文子串检索走倒排索引。
//
// 例：'整理Q3数据平台迁移方案' -> 'q3 整理 数据 据平 平台 台迁 迁移 移方 方案'

const ASCII_WORD = /[A-Za-z0-9_]+/;
/** 任一可索引片段（ASCII 词或中文串），用来按**原文顺序**遍历 */
const ANY_CHUNK = /[A-Za-z0-9_]+|[\u4e00-\u9fff\u3400-\u4dbf]+/g;

/**
 * 把任意文本折叠成 FTS5 可正确切分的检索串。
 *
 * **必须按原文顺序输出**：曾有两个各自独立的循环（先全部 ASCII 词、再全部中文 bigram），
 * 于是中英混排的顺序被丢掉：
 *   索引 "…迁移方案_v3.docx…" → `nas _v3 docx 设计 迁移 移方 方案 …`
 *   查询 "迁移方案_v3"        → `_v3 迁移 移方 方案`
 * `_v3` 跑到最前面，短语匹配就永远命中不了 —— 中英混排的查询全都搜不到，
 * 而纯中文查询碰巧顺序自洽，所以这个问题藏了很久（见 design.md 缺陷表 36）。
 */
export function toTokens(text: string): string {
  const parts: string[] = [];

  for (const matched of text.matchAll(ANY_CHUNK)) {
    const chunk = matched[0];
    if (ASCII_WORD.test(chunk)) {
      parts.push(chunk.toLowerCase());
      continue;
    }
    if (chunk.length === 1) {
      parts.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length - 1; i += 1) {
      parts.push(chunk.slice(i, i + 2));
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
 * 把折叠后的查询串成 FTS5 的列限定匹配。
 *
 * 用 **AND（空格分隔）而不是短语**：折叠是逐段做的，查询里的词序与正文的词序
 * 本来就不需要相同 —— "方案_v3" 要能命中 "…迁移方案_v3.docx…"。
 * 用短语匹配时，任何跨越"中文/非中文"边界的查询都会落空。
 *
 * 精度由 bigram 本身保证（"迁移 移方 方案" 三个 bigram 同时命中才返回），
 * 因此放宽到 AND 不会引入明显的误召回。
 */
export function buildFtsMatch(query: string): string | null {
  if (!isFtsQueryUsable(query)) return null;
  const tokens = toTokens(query).trim();
  if (tokens.length === 0) return null;
  const escaped = tokens.replaceAll('"', '""');
  return `tokens : "${escaped}"`;
}
