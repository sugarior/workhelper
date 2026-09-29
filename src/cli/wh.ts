#!/usr/bin/env node
// WorkHelper 命令行入口。
//
// 分层：本文件只做参数解析、调用服务、渲染输出。
// 业务规则一律在 core/service 里，SQL 一律在 core/repo 里——
// 因此将来把本文件换成 Tauri 窗口时，内核不需要任何改动。

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, closeDatabase, DEFAULT_DB_FILENAME } from '../core/db/connection.ts';
import { migrate, currentVersion, listMigrations } from '../core/db/migrations.ts';
import { createServices } from '../core/service/index.ts';
import { isDomainError } from '../core/domain/errors.ts';
import { defaultDataDir, resolveFromRoot } from '../core/paths.ts';
import { resolveRef } from './refs.ts';
import { runVerify } from './verify.ts';
import type { WorkHelperServices, ClassifyTarget } from '../core/service/index.ts';
import type { ArchiveKind, ProgressKind, Task, TaskStatus } from '../core/domain/types.ts';

const VERSION = '0.1.0';

const HELP = `WorkHelper ${VERSION} —— 常驻桌面的个人工作秘书

用法：node src/cli/wh.ts <命令> [参数...]

捕获
  add <文本>                快记一句（自动识别「下周三」「明天」等日期）
  inbox                     查看待处理的收件箱
  task <id...> [选项]       把收件箱条目转成任务
                            --project <id> --due <日期> --priority high|normal|low
  archive <id...> [选项]    把收件箱条目存为资料（--kind note|meeting|link|file）
  discard <id...>           丢弃收件箱条目
  undo                      撤销上一次分类

推进
  today                     今日视图（逾期 / 今天到期 / 已排入 / 阻塞）
  ls [选项]                 列出任务（--status <状态> --project <id>）
  doing <id>                标记为进行中
  block <id> <原因>         标记为阻塞（同时留下一条卡点记录）
  unblock <id>              解除阻塞
  done <id> [--cascade]     完成任务（--cascade 一并完成其子任务）
  plan <id> / unplan <id>   加入 / 移出「今日」
  note <id> [类型] <内容>   追加进展；类型为 进展|卡点|决定|等待，默认进展
  timeline <id>             查看任务的全部进展

结构
  proj list                  列出项目（默认）
  proj add <名称>            新建项目（--goal <目标>）
  proj show <id>             查看项目树
  proj rm <id>               删除项目（其任务保留但解除归属）
  sub <任务id> <标题>        给任务加子任务
  subdone <子任务id>         完成子任务

查询与系统
  search <关键词>           全库检索（中文子串可用）
  log [日期] [正文]         查看每日汇总，或保存手写正文
  backup                    立即备份并轮换旧快照
  trash list|restore|purge  回收站（默认 list）
  settings [键 值]          查看或修改设置（日界小时用键 boundary）
  reindex                   重建检索索引
  verify                    完整性与业务自检

数据库
  migrate                   升级数据库结构（幂等）
  status                    数据库与运行状态
  help                      显示本帮助
  --version                 显示版本

通用选项
  --db <路径>               数据库文件，默认 <项目根>/${DEFAULT_DB_FILENAME}
  --data <目录>             数据目录（备份所在），默认 <项目根>/data
                            相对路径的解释基准是项目根，不随当前目录变化
  --json                    以 JSON 输出，便于脚本处理
`;

interface CliContext {
  database: DatabaseSync;
  dbPath: string;
  dataDir: string;
  json: boolean;
  services: WorkHelperServices;
}

// ---------- 输出辅助 ----------

const STATUS_MARK: Readonly<Record<TaskStatus, string>> = {
  todo: '[ ]',
  doing: '[~]',
  blocked: '[!]',
  done: '[x]',
  cancelled: '[-]',
};

const PROGRESS_LABEL: Readonly<Record<ProgressKind, string>> = {
  progress: '进展',
  blocker: '卡点',
  decision: '决定',
  waiting: '等待',
};

const PROGRESS_KEYWORDS: Readonly<Record<string, ProgressKind>> = {
  进展: 'progress',
  卡点: 'blocker',
  决定: 'decision',
  等待: 'waiting',
  progress: 'progress',
  blocker: 'blocker',
  decision: 'decision',
  waiting: 'waiting',
};

const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done', 'cancelled'];
const ARCHIVE_KINDS: readonly ArchiveKind[] = ['note', 'meeting', 'link', 'file'];
const PRIORITIES: readonly Task['priority'][] = ['high', 'normal', 'low'];

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 控制台宽度有限，超长文本压平并截断 */
function clip(text: string, width = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function formatTaskLine(task: Task, dayKey: string): string {
  const line = `${STATUS_MARK[task.status]} ${shortId(task.id)}  ${clip(task.title)}`;
  const tags: string[] = [];
  const open = task.status !== 'done' && task.status !== 'cancelled';

  if (task.dueDate !== null) {
    tags.push(open && task.dueDate < dayKey ? `逾期 ${task.dueDate}` : `截止 ${task.dueDate}`);
  }
  if (task.priority === 'high') tags.push('高优先');
  if (task.plannedFor === dayKey) tags.push('今日');
  if (task.status === 'blocked' && task.blockedReason !== null) tags.push(`卡在：${clip(task.blockedReason, 20)}`);

  return tags.length === 0 ? line : `${line}  (${tags.join(' · ')})`;
}

function printSection(title: string, tasks: readonly Task[], dayKey: string): void {
  if (tasks.length === 0) return;
  console.log(`\n${title}（${tasks.length}）`);
  for (const task of tasks) console.log(`  ${formatTaskLine(task, dayKey)}`);
}

// ---------- 参数取值辅助 ----------

function optionalString(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  flagName: string,
): T | undefined {
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`--${flagName} 只能是 ${allowed.join(' / ')}，收到「${raw}」`);
  }
  return raw as T;
}

// ---------- 命令实现 ----------

function commandAdd(context: CliContext, text: string, kindRaw: string | undefined): void {
  const kindHint = oneOf(kindRaw, ['todo', 'note'] as const, 'kind') ?? null;
  const { item, parsed, title } = context.services.capture.quickCapture({ text, kindHint });

  if (context.json) {
    console.log(JSON.stringify({ item, parsed, title }, null, 2));
    return;
  }
  const suffix = parsed === null ? '' : `  → 截止 ${parsed.dayKey}`;
  console.log(`已记入收件箱 ${shortId(item?.id ?? '')}${suffix}`);
  if (title.length > 0 && title !== text.trim()) console.log(`标题：${title}`);
  console.log(`待处理共 ${context.services.capture.countPending()} 条`);
}

function commandInbox(context: CliContext): void {
  const items = context.services.capture.listPending({ limit: 100 });
  if (context.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log('收件箱是空的');
    return;
  }
  console.log(`收件箱（${items.length} 条待处理）`);
  items.forEach((item, index) => {
    const due = item.parsedDue === null ? '' : `  → 截止 ${item.parsedDue}`;
    const raw = item.rawInput === null ? '' : `  [原文: ${clip(item.rawInput, 24)}]`;
    console.log(`  ${String(index + 1).padStart(2)}. ${shortId(item.id)}  ${clip(item.body)}${due}${raw}`);
  });
  console.log('\n用 task <id> 转成任务，archive <id> 存为资料，discard <id...> 丢弃');
}

function buildClassifyTarget(
  context: CliContext,
  command: 'task' | 'archive' | 'discard',
  values: Record<string, unknown>,
): ClassifyTarget {
  if (command === 'discard') return { kind: 'discard' };

  if (command === 'archive') {
    const archiveKind = oneOf(optionalString(values, 'kind'), ARCHIVE_KINDS, 'kind');
    return archiveKind === undefined ? { kind: 'archive' } : { kind: 'archive', archiveKind };
  }

  const projectFlag = optionalString(values, 'project');
  const due = optionalString(values, 'due');
  const priority = oneOf(optionalString(values, 'priority'), PRIORITIES, 'priority');

  return {
    kind: 'task',
    projectId: projectFlag === undefined ? null : resolveRef(context.database, 'project', projectFlag).id,
    dueDate: due ?? null,
    priority,
  };
}

function commandClassify(
  context: CliContext,
  ids: string[],
  command: 'task' | 'archive' | 'discard',
  values: Record<string, unknown>,
): void {
  if (ids.length === 0) throw new Error(`请在命令后给出至少一个收件箱条目 id`);

  const target = buildClassifyTarget(context, command, values);
  const inboxIds = ids.map((id) => resolveRef(context.database, 'inbox', id).id);
  const results =
    inboxIds.length === 1
      ? [context.services.capture.classify(inboxIds[0] ?? '', target)]
      : context.services.capture.classifyMany(inboxIds, target);

  if (context.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const result of results) {
    const label = result.createdKind === 'task' ? '任务' : result.createdKind === 'archive' ? '资料' : '已丢弃';
    console.log(`${label} ${shortId(result.createdId)}`);
  }
  console.log(`剩余待处理 ${context.services.capture.countPending()} 条（可用 undo 撤销）`);
}

function commandToday(context: CliContext): void {
  const view = context.services.tracking.todayView();
  if (context.json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  console.log(
    `今日视图 ${view.dayKey}    未结束 ${view.counts.open} · 今天完成 ${view.counts.doneToday} · 收件箱 ${view.inboxCount}`,
  );
  printSection('逾期', view.overdue, view.dayKey);
  printSection('今天到期', view.dueToday, view.dayKey);
  printSection('已排入今日', view.planned, view.dayKey);
  printSection('阻塞中', view.blocked, view.dayKey);

  const total = view.overdue.length + view.dueToday.length + view.planned.length + view.blocked.length;
  if (total === 0) console.log('\n今天没有待办事项');
}

function commandList(context: CliContext, values: Record<string, unknown>): void {
  const status = oneOf(optionalString(values, 'status'), TASK_STATUSES, 'status');
  const projectFlag = optionalString(values, 'project');
  const projectId = projectFlag === undefined ? undefined : resolveRef(context.database, 'project', projectFlag).id;

  const tasks = context.services.planning.listTasks({ status, projectId });
  if (context.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (tasks.length === 0) {
    console.log('没有符合条件的任务');
    return;
  }
  const dayKey = context.services.currentDayKey();
  for (const task of tasks) console.log(formatTaskLine(task, dayKey));
  console.log(`\n共 ${tasks.length} 条`);
}

/** 解析任务 id 并返回其标题，供各推进命令复用 */
function taskRef(context: CliContext, raw: string | undefined) {
  return resolveRef(context.database, 'task', raw ?? '');
}

function commandNote(context: CliContext, args: string[], rawKind: string | undefined): void {
  const ref = taskRef(context, args[0]);
  const first = args[1];
  // 支持 "note <id> 卡点 内容" 与 "note <id> 内容 --note 卡点" 两种写法
  const kindFromPosition = first !== undefined && PROGRESS_KEYWORDS[first] !== undefined ? first : undefined;
  const kindRaw = rawKind ?? kindFromPosition;
  const bodyParts = kindFromPosition === undefined ? args.slice(1) : args.slice(2);
  const body = bodyParts.join(' ').trim();
  if (body.length === 0) throw new Error('请给出进展内容');

  const kind = kindRaw === undefined ? 'progress' : PROGRESS_KEYWORDS[kindRaw];
  if (kind === undefined) {
    throw new Error(`未知的进展类型「${kindRaw}」，可用：进展 / 卡点 / 决定 / 等待`);
  }

  const { entry, task } = context.services.tracking.addProgress({
    target: { kind: 'task', id: ref.id },
    kind,
    body,
  });
  if (context.json) {
    console.log(JSON.stringify({ entry, task }, null, 2));
    return;
  }
  console.log(`${PROGRESS_LABEL[kind]}已记录 ${shortId(entry.id)}  → ${clip(ref.title)}`);
  if (task !== undefined) console.log(`  任务状态已联动为 ${task.status}（${clip(task.blockedReason ?? '', 30)}）`);
}

function commandTimeline(context: CliContext, rawId: string | undefined): void {
  const ref = taskRef(context, rawId);
  const entries = context.services.tracking.taskTimeline(ref.id);
  if (context.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.log(`${clip(ref.title)}  共 ${entries.length} 条记录`);
  for (const entry of entries) {
    const when = entry.occurredAt.slice(0, 16).replace('T', ' ');
    console.log(`  ${when}  [${PROGRESS_LABEL[entry.kind]}]  ${clip(entry.body, 50)}`);
  }
}

function commandProjects(context: CliContext, args: string[], values: Record<string, unknown>): void {
  const planning = context.services.planning;
  const action = args[0] ?? 'list';

  switch (action) {
    case 'list': {
      const projects = planning.listProjects();
      if (context.json) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }
      if (projects.length === 0) {
        console.log('还没有项目，用 proj add <名称> 创建');
        return;
      }
      for (const project of projects) {
        const tree = planning.projectTree(project.id);
        const status = project.status === 'active' ? '' : ` [${project.status}]`;
        console.log(`  ${shortId(project.id)}  ${clip(project.title)}${status}  ${tree.counts.done}/${tree.counts.total} 任务`);
      }
      return;
    }
    case 'add': {
      const title = args.slice(1).join(' ').trim();
      const project = planning.createProject({ title, goal: optionalString(values, 'goal') });
      console.log(`项目已创建 ${shortId(project.id)}  ${clip(project.title)}`);
      return;
    }
    case 'show': {
      const ref = resolveRef(context.database, 'project', args[1] ?? '');
      const tree = planning.projectTree(ref.id);
      if (context.json) {
        console.log(JSON.stringify(tree, null, 2));
        return;
      }
      const dayKey = context.services.currentDayKey();
      console.log(`${clip(tree.project.title)}  ${tree.counts.done}/${tree.counts.total} 任务 · ${tree.progressCount} 条进展`);
      if (tree.project.goal !== null) console.log(`目标：${tree.project.goal}`);
      for (const node of tree.tasks) {
        console.log(`  ${formatTaskLine(node.task, dayKey)}`);
        for (const subtask of node.subtasks) {
          const mark = subtask.status === 'done' ? '[x]' : '[ ]';
          console.log(`      ${mark} ${shortId(subtask.id)}  ${clip(subtask.title, 50)}`);
        }
      }
      return;
    }
    case 'rm': {
      const ref = resolveRef(context.database, 'project', args[1] ?? '');
      const result = planning.deleteProject(ref.id);
      console.log(`项目已删除；${result.detachedTasks} 个任务保留但不再归属该项目`);
      return;
    }
    default:
      throw new Error(`未知的项目子命令「${action}」，可用：list / add / show / rm`);
  }
}

function commandSearch(context: CliContext, query: string): void {
  if (query.trim().length === 0) throw new Error('请给出搜索关键词');
  const hits = context.services.search.search(query, { limit: 30 });
  if (context.json) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }
  if (hits.length === 0) {
    console.log(`没有找到与「${query}」相关的内容`);
    return;
  }
  for (const hit of hits) {
    const mark = hit.alive ? ' ' : '?';
    console.log(
      `  ${mark} ${hit.entityLabel.padEnd(4)} ${shortId(hit.entityId)}  ${clip(hit.displayTitle || hit.body, 56)}`,
    );
  }
  console.log(`\n共 ${hits.length} 条（前缀 ? 表示索引里有但记录已不存在）`);
}

function commandLog(context: CliContext, args: string[]): void {
  const journal = context.services.journal;
  const dayKey = args[0] ?? context.services.currentDayKey();

  if (args.length >= 2) {
    const body = args.slice(1).join(' ');
    const saved = journal.save(dayKey, body);
    console.log(`已保存 ${saved.dayKey} 的日志（${body.length} 字）`);
    return;
  }

  const summary = journal.summarize(dayKey);
  if (context.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`=== ${dayKey} 汇总（自动生成，不落库）===`);
  const { counts } = summary;
  console.log(`完成 ${counts.completed} · 新增 ${counts.created} · 卡点 ${counts.blockers} · 顺延 ${counts.carriedOver}`);

  if (summary.completedTasks.length > 0) {
    console.log('\n完成的任务');
    for (const task of summary.completedTasks) console.log(`  [x] ${shortId(task.id)}  ${clip(task.title)}`);
  }
  if (summary.completedSubtasks.length > 0) {
    console.log('\n完成的子任务');
    for (const item of summary.completedSubtasks) {
      console.log(`  [x] ${clip(item.taskTitle, 24)} › ${clip(item.subtask.title, 30)}`);
    }
  }
  if (summary.carriedOver.length > 0) {
    console.log('\n顺延（到期未完成）');
    for (const task of summary.carriedOver) {
      console.log(`  ${shortId(task.id)}  ${clip(task.title)}  (截止 ${task.dueDate})`);
    }
  }
  if (summary.blockers.length > 0) {
    console.log('\n卡点');
    for (const entry of summary.blockers) console.log(`  ${clip(entry.body, 60)}`);
  }
  if (summary.timeline.length > 0) {
    console.log('\n进展时间线');
    for (const entry of summary.timeline) {
      console.log(`  ${entry.occurredAt.slice(11, 16)}  [${PROGRESS_LABEL[entry.kind]}]  ${clip(entry.body, 50)}`);
    }
  }
  const body = summary.log?.body;
  console.log(`\n我的正文：${body === undefined || body === null ? `（还没写，用 log ${dayKey} <正文> 补上）` : body}`);
}

function commandSettings(context: CliContext, args: string[]): void {
  const { settings } = context.services.system;

  if (args.length >= 2) {
    const [key, rawValue] = args;
    if (key === 'boundary' || key === 'day.boundaryHour') {
      settings.setDayBoundaryHour(Number(rawValue));
      console.log(`日界小时已设为 ${settings.dayBoundaryHour()}（0 表示按自然日切分）`);
      return;
    }
    let parsed: unknown = rawValue;
    try {
      parsed = JSON.parse(rawValue ?? '');
    } catch {
      parsed = rawValue;
    }
    settings.set(key ?? '', parsed);
    console.log(`已设置 ${key} = ${JSON.stringify(parsed)}`);
    return;
  }

  if (context.json) {
    console.log(JSON.stringify({ dayBoundaryHour: settings.dayBoundaryHour(), entries: settings.list() }, null, 2));
    return;
  }
  console.log(`日界小时  : ${settings.dayBoundaryHour()}（凌晨 ${settings.dayBoundaryHour()} 点切日）`);
  const entries = settings.list();
  if (entries.length === 0) {
    console.log('其它设置  : （无）');
    return;
  }
  console.log('其它设置  :');
  for (const entry of entries) console.log(`  ${entry.key} = ${JSON.stringify(entry.value)}`);
}

function commandTrash(context: CliContext, args: string[]): void {
  const { trash } = context.services.system;
  const action = args[0] ?? 'list';

  switch (action) {
    case 'list': {
      const entries = trash.list();
      if (context.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log('回收站是空的');
        return;
      }
      console.log(`回收站（保留 ${trash.retentionDays} 天）`);
      for (const entry of entries) {
        const left = entry.daysLeft < 0 ? '已过期待清理' : `还剩 ${entry.daysLeft} 天`;
        console.log(`  ${entry.label.padEnd(6)} ${shortId(entry.entityId)}  ${clip(entry.title, 40)}  (${left})`);
      }
      return;
    }
    case 'restore':
    case 'purge': {
      const prefix = args[1];
      if (action === 'purge' && prefix === undefined) {
        const purged = trash.purgeExpired();
        const total = Object.values(purged).reduce((sum, count) => sum + count, 0);
        console.log(`已清理 ${total} 条过期记录`);
        return;
      }
      if (prefix === undefined) throw new Error(`请给出要${action === 'restore' ? '恢复' : '删除'}的 id`);

      const matches = trash.list().filter((entry) => entry.entityId.startsWith(prefix));
      if (matches.length === 0) throw new Error(`回收站里找不到「${prefix}」`);
      if (matches.length > 1) {
        const list = matches.map((entry) => `  ${shortId(entry.entityId)}  ${entry.label} ${clip(entry.title, 30)}`).join('\n');
        throw new Error(`「${prefix}」匹配到 ${matches.length} 条，请多给几位：\n${list}`);
      }
      const target = matches[0];
      if (target === undefined) throw new Error(`回收站里找不到「${prefix}」`);

      if (action === 'restore') {
        trash.restore(target.entityType, target.entityId);
        console.log(`已恢复${target.label} ${clip(target.title, 40)}`);
      } else {
        trash.purgeOne(target.entityType, target.entityId);
        console.log(`已彻底删除${target.label} ${clip(target.title, 40)}（不可恢复）`);
      }
      return;
    }
    default:
      throw new Error(`未知的回收站子命令「${action}」，可用：list / restore / purge`);
  }
}

function commandStatus(context: CliContext): void {
  const version = currentVersion(context.database);
  const migrations = listMigrations().length;
  if (context.json) {
    console.log(JSON.stringify({ dbPath: context.dbPath, schemaVersion: version, migrations }, null, 2));
    return;
  }
  console.log(`数据库    : ${context.dbPath}`);
  console.log(`结构版本  : v${version}（可用迁移 ${migrations} 个）`);
  console.log(`日界小时  : ${context.services.system.settings.dayBoundaryHour()}`);
  console.log(`收件箱    : ${context.services.capture.countPending()} 条待处理`);
  console.log(`索引条数  : ${context.services.search.countIndexed()}`);
  console.log(`回收站    : ${context.services.system.trash.count()} 条`);
  if (version < migrations) {
    console.log('提示      : 结构落后于代码，请运行 migrate');
    process.exitCode = 1;
  }
}

// ---------- 主入口 ----------

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: 'boolean' },
      help: { type: 'boolean' },
      json: { type: 'boolean' },
      db: { type: 'string' },
      data: { type: 'string' },
      project: { type: 'string' },
      due: { type: 'string' },
      priority: { type: 'string' },
      kind: { type: 'string' },
      goal: { type: 'string' },
      status: { type: 'string' },
      note: { type: 'string' },
      cascade: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  const values = parsed.values as Record<string, unknown>;
  const positionals = parsed.positionals;

  if (values.version === true) {
    console.log(VERSION);
    return;
  }

  const command = positionals[0] ?? 'help';
  const rest = positionals.slice(1);

  if (command === 'help' || values.help === true) {
    console.log(HELP);
    return;
  }

  const dataDir = optionalString(values, 'data') === undefined
    ? defaultDataDir()
    : resolveFromRoot(optionalString(values, 'data') ?? '');
  const dbPath = optionalString(values, 'db') === undefined
    ? join(dataDir, DEFAULT_DB_FILENAME)
    : resolveFromRoot(optionalString(values, 'db') ?? '');
  const database = openDatabase(dbPath);

  try {
    migrate(database);
    const context: CliContext = {
      database,
      dbPath,
      dataDir,
      json: values.json === true,
      services: createServices(database, { dataDir }),
    };

    switch (command) {
      case 'add':
        commandAdd(context, rest.join(' '), optionalString(values, 'kind'));
        return;
      case 'inbox':
        commandInbox(context);
        return;
      case 'task':
      case 'archive':
      case 'discard':
        commandClassify(context, rest, command, values);
        return;
      case 'undo': {
        const done = context.services.capture.undoLastClassification();
        console.log(done ? '已撤销上一次分类' : '没有可撤销的操作');
        return;
      }
      case 'today':
        commandToday(context);
        return;
      case 'ls':
        commandList(context, values);
        return;
      case 'doing': {
        const ref = taskRef(context, rest[0]);
        const task = context.services.tracking.startTask(ref.id);
        console.log(`${STATUS_MARK[task.status]} ${clip(task.title)}`);
        return;
      }
      case 'block': {
        const ref = taskRef(context, rest[0]);
        const task = context.services.tracking.blockTask(ref.id, rest.slice(1).join(' ').trim());
        console.log(`${STATUS_MARK.blocked} ${clip(task.title)}\n  卡在：${task.blockedReason ?? ''}`);
        return;
      }
      case 'unblock': {
        const ref = taskRef(context, rest[0]);
        const task = context.services.tracking.unblockTask(ref.id);
        console.log(`${STATUS_MARK[task.status]} ${clip(task.title)}`);
        return;
      }
      case 'done': {
        const ref = taskRef(context, rest[0]);
        const task = context.services.tracking.completeTask(ref.id, {
          cascadeSubtasks: values.cascade === true,
        });
        console.log(`${STATUS_MARK.done} ${clip(task.title)}`);
        return;
      }
      case 'plan': {
        const ref = taskRef(context, rest[0]);
        console.log(`已排入今日：${clip(context.services.tracking.addToToday(ref.id).title)}`);
        return;
      }
      case 'unplan': {
        const ref = taskRef(context, rest[0]);
        console.log(`已移出今日：${clip(context.services.tracking.removeFromToday(ref.id).title)}`);
        return;
      }
      case 'note':
        commandNote(context, rest, optionalString(values, 'note'));
        return;
      case 'timeline':
        commandTimeline(context, rest[0]);
        return;
      case 'proj':
        commandProjects(context, rest, values);
        return;
      case 'sub': {
        const ref = taskRef(context, rest[0]);
        const subtask = context.services.planning.createSubtask({
          taskId: ref.id,
          title: rest.slice(1).join(' '),
        });
        console.log(`子任务已添加 ${shortId(subtask.id)}  ${clip(subtask.title)}`);
        return;
      }
      case 'subdone': {
        const ref = resolveRef(database, 'subtask', rest[0] ?? '');
        const subtask = context.services.planning.setSubtaskStatus(ref.id, 'done');
        console.log(`[x] ${clip(subtask.title)}`);
        return;
      }
      case 'search':
        commandSearch(context, rest.join(' '));
        return;
      case 'log':
        commandLog(context, rest);
        return;
      case 'backup': {
        const file = await context.services.system.backup('manual');
        const removed = context.services.system.rotateBackups();
        console.log(`备份完成：${file.fileName}（${(file.byteSize / 1024).toFixed(0)} KB）`);
        if (removed.length > 0) console.log(`轮换清理 ${removed.length} 个旧快照`);
        console.log(`备份目录：${join(dataDir, 'backups')}`);
        return;
      }
      case 'reindex':
        console.log(`索引已重建，共 ${context.services.search.reindexAll()} 条`);
        return;
      case 'trash':
        commandTrash(context, rest);
        return;
      case 'settings':
        commandSettings(context, rest);
        return;
      case 'verify':
        runVerify(context);
        return;
      case 'migrate': {
        const result = migrate(database);
        console.log(result.applied.length === 0 ? `结构已是最新（v${result.to}）` : `结构升级到 v${result.to}`);
        return;
      }
      case 'status':
        commandStatus(context);
        return;
      default:
        console.error(`未知命令：${command}\n`);
        console.log(HELP);
        process.exitCode = 2;
    }
  } finally {
    closeDatabase(database);
  }
}

try {
  await main();
} catch (error) {
  if (isDomainError(error)) {
    console.error(`[${error.code}] ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
