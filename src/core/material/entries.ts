// 资料入口的识别（需求 F-13 / 设计 §4.5）。
//
// 职责：把速记板里粘贴的一段文本，切成若干"入口"（本地目录 / 本地文件 / 网址）。
// 这是纯函数，不碰数据库 —— 识别规则是产品语义，必须能单独测。
//
// 用户确认的规则（需求 §4.2 D4）：
//   · **一行一个入口**：行内除路径/链接外的文字，成为**该入口的注释**
//   · **识别不出路径/链接的行原样保留**为普通收件箱条目 —— 绝不丢内容
//
// 为什么"绝不丢内容"是硬要求：用户粘贴的是他自己写的东西。
// 若某行既不是路径也不是链接，我们不能猜、更不能丢 —— 它就是一条普通记录。

import { MATERIAL_ENTRY_KINDS } from '../domain/types.ts';
import type { MaterialEntryKind } from '../domain/types.ts';

export interface EntryDraft {
  kind: MaterialEntryKind;
  /** 绝对路径或 URL，原样保留（不做规范化，见需求 §4.2 D1/D6） */
  target: string;
  /** 该入口自己的注释，可为空 */
  note: string | null;
}

export interface ParsedEntries {
  entries: EntryDraft[];
  /**
   * 仍然是空数组，保留字段是为了调用方不必改签名。
   *
   * **这里曾经把"识别不出路径/链接的行"放进 leftovers，然后在「存为资料」时丢掉** ——
   * 那是错的：那样的行（"纸质原件在左抽屉第二格"）本身就是资料内容，
   * 它指向实物，只是不是 dir/file/url 三种形态之一。
   * M3 禁止的是**存文件字节**，不是禁止文字成为资料。
   * 现在这类行成为 `kind: 'text'` 的入口，一行一个入口的规则因此保持完整。
   */
  leftovers: string[];
}

/** 网址：只认带协议的写法，避免把 "example.com" 这种裸域名当入口 */
const URL_PATTERN = /^(?:https?|ftp|file):\/\/\S+$/i;

/**
 * 文件系统路径的候选。
 *
 * 刻意只认这几类"看起来像路径"的写法，**不猜**：
 *  · `D:\...` / `D:/...`   Windows 盘符
 *  · `\\server\share`      UNC（内网共享，用户明确会用）
 *  · `/home/...`           Unix 风格绝对路径
 *  · `a\b` / `a/b`         含分隔符的相对或绝对路径
 *
 * 裸文件名（`方案.docx`，没有分隔符）**不算** —— 它太容易是普通文字，
 * 宁可让它留在"未识别"里由用户处理，也不要猜错。
 */
const PATH_CANDIDATE = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>|，。；：]*|[^\s"'<>|，。；：]*[\\/][^\s"'<>|，。；：]*/;

/**
 * 成对引号里的内容整体作为路径候选。
 *
 * 为什么需要它：从资源管理器"复制为路径"粘出来的是 `"D:\带 空格\目录"`，
 * 而 PATH_CANDIDATE 遇到空白就停 —— 会把带空格的路径截断成半截。
 * 引号是用户明确给出的边界，应当优先于"遇空白即停"的启发式。
 */
const QUOTED_CANDIDATE = /"([^"]+)"|'([^']+)'/;

/** 结尾是分隔符 → 目录；末段带扩展名 → 文件；否则按目录处理 */
function kindOfPath(target: string): MaterialEntryKind {
  if (/[\\/]$/.test(target)) return 'dir';
  const lastSegment = target.split(/[\\/]/).filter((part) => part.length > 0).at(-1) ?? '';
  return /\.[A-Za-z0-9]{1,8}$/.test(lastSegment) ? 'file' : 'dir';
}

/** 去掉路径两侧的引号与尾随标点，但**不动路径内部** */
function tidyTarget(raw: string): string {
  let value = raw.trim();
  // 成对引号（从资源管理器"复制为路径"常带引号）
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  // 中文句读常被一起粘进来，去掉尾随的
  return value.replace(/[，。；：、）】》”’]+$/, '').trim();
}

/** 命中片段两侧剩下的文字就是注释 */
function noteFrom(line: string, matched: string): string | null {
  const index = line.indexOf(matched);
  if (index === -1) return null;
  const left = line.slice(0, index);
  const right = line.slice(index + matched.length);
  const note = `${left} ${right}`
    .replace(/\s{2,}/g, ' ')
    // 路径被剥掉后可能留下孤零零的句读（"工作区是 X，别忘了" → "工作区是 ，别忘了"）
    .replace(/\s*[，。；：、]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return note.length === 0 ? null : note;
}

function tryUrl(line: string): EntryDraft | null {
  // URL 可能出现在行中间（"看下 <url> 这个模板"），因此逐词试
  for (const word of line.split(/\s+/)) {
    const tidy = tidyTarget(word);
    if (URL_PATTERN.test(tidy)) {
      return { kind: 'url', target: tidy, note: noteFrom(line, word) };
    }
  }
  return null;
}

function tryPath(line: string): EntryDraft | null {
  // 先试引号内的整体内容（能保住带空格的路径），再退回"遇空白即停"的启发式
  const quoted = QUOTED_CANDIDATE.exec(line);
  const candidates: string[] = [];
  if (quoted !== null) candidates.push(quoted[1] ?? quoted[2] ?? '');
  const loose = PATH_CANDIDATE.exec(line);
  if (loose !== null) candidates.push(loose[0]);

  for (const candidate of candidates) {
    const target = tidyTarget(candidate);
    // 太短的不算：单个分隔符、或只剩盘符前缀（"D:\" 后面其实什么都没有）
    if (target.length < 3) continue;
    if (/^[A-Za-z]:[\\/]?$/.test(target)) continue;
    if (/^[\\/]+$/.test(target)) continue;
    return { kind: kindOfPath(target), target, note: noteFrom(line, candidate) };
  }
  return null;
}

/**
 * 解析速记板输入：一行一个入口。
 *
 * 识别不出路径/链接的行**不是被丢掉，而是成为 `text` 入口** ——
 * 一行一个入口的规则因此没有例外（见 ParsedEntries 的说明）。
 *
 * 顺序上**先试网址再试路径**：`file:///D:/x` 这类既像 URL 又像路径，
 * 按 URL 处理更符合"点一下用浏览器/默认程序打开"的预期。
 */
export function parseEntries(text: string): ParsedEntries {
  const entries: EntryDraft[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const draft = tryUrl(line) ?? tryPath(line);
    if (draft === null) {
      // 文字入口：整行就是内容，没有"注释"可言（行本身就是那句话）
      entries.push({ kind: 'text', target: line, note: null });
    } else {
      entries.push(draft);
    }
  }

  return { entries, leftovers: [] };
}

/** 供界面判断"这行会被当成哪一类入口"（速记板预览用） */
export function classifyLine(line: string): EntryDraft | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  return tryUrl(trimmed) ?? tryPath(trimmed) ?? { kind: 'text', target: trimmed, note: null };
}

/** 这行会被识别成"可打开之物"吗（`text` 不算） */
export function looksLikeEntry(line: string): boolean {
  const draft = classifyLine(line);
  return draft !== null && draft.kind !== 'text';
}

/** 断言：识别出的 kind 必须是合法取值（防止正则改动引入非法值） */
export function assertEntryKind(kind: string): asserts kind is MaterialEntryKind {
  if (!(MATERIAL_ENTRY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`非法的资料入口类型：${kind}`);
  }
}
