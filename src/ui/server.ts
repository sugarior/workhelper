// 本地 HTTP 服务：给图形界面提供通路（M0 的界面形态）。
//
// 安全边界（设计 §7.1）：
//  - 只绑 127.0.0.1，不引入任何外部可达面
//  - 只接受白名单内的服务方法，不做通用反射调用
//  - 静态文件做路径穿越与符号链接逃逸检查
//
// 不引入 Web 框架：node:http 足够，且符合零依赖约束。

import { createServer } from 'node:http';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createServices } from '../core/service/index.ts';
import { defaultDataDir, resolveFromRoot } from '../core/paths.ts';
import { openDatabase, closeDatabase, DEFAULT_DB_FILENAME } from '../core/db/connection.ts';
import { migrate } from '../core/db/migrations.ts';
import { isDomainError } from '../core/domain/errors.ts';
import type { WorkHelperServices } from '../core/service/index.ts';

export const DEFAULT_PORT = 7317;
const STATIC_DIR = join(import.meta.dirname, 'static');
/** 请求体上限：界面只发 JSON，5MB 足够且能挡住意外的超大请求 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface ApiRequest {
  service: string;
  method: string;
  params: unknown;
}

export interface ServerOptions {
  database: DatabaseSync;
  services: WorkHelperServices;
  port: number;
  /** 备份原因，透传给 system.backup（界面触发的备份一律记作 manual） */
  backupReason?: string;
  /** 是否打印访问日志（默认只打错误） */
  verbose?: boolean;
}

/**
 * 服务方法白名单：界面实际用到的方法才暴露。
 * 不做 "任意 service.method" 的通用转发——那样等于把整个内核暴露成 HTTP 接口，
 * 日后加接口时再逐个补白名单，比事后收紧容易得多。
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  capture: ['quickCapture', 'listPending', 'countPending', 'classify', 'classifyMany',
    'undoLastClassification', 'ignoreItem'],
  /**
   * `deleteProject` **刻意不放行**（与 `deleteTask` / `deleteSubtask` 一致）。
   *
   * 项目的终止方式是「归档」（`updateProject({status:'archived'})`），
   * 与任务的「中止」对称：保留历史、进展与挂靠的资料。
   * 放行删除会让「不做了」变成两条近义路径，也会在回收站里制造
   * 「历史已删除」条目 —— 而那个栏目本该是死的（§4.3）。
   */
  planning: ['listProjects', 'projectTree', 'createProject', 'updateProject',
    'listTasks', 'createTask', 'completeTask', 'reopenTask', 'updateTask',
    'createSubtask', 'setSubtaskStatus', 'reorder'],
  tracking: ['addProgress', 'taskTimeline', 'todayView', 'openTasksView', 'completedView', 'abortedView', 'addToToday', 'removeFromToday',
    'startTask', 'blockTask', 'unblockTask', 'completeTask', 'abortTask',
    'focus', 'focusTask', 'unfocus', 'noteOnFocus', 'focusCandidates'],
  journal: ['summarize', 'save'],
  search: ['search'],
  /**
   * 资料（F-11~F-14）。
   *
   * `create` 把「入口 + 挂靠目标」放在**同一次调用**里，而不是"先建资料再挂靠"——
   * 后者会短暂存在一条违反 M1 的零挂靠资料，且中途失败就留下孤儿。
   */
  material: ['create', 'get', 'list', 'listForTarget', 'update', 'link', 'unlink', 'remove', 'entryTargets'],
  // `setDayBoundaryHour` 是**专用方法而不是通用的 setSetting**：
  // 通用写接口等于让前端能覆盖任意设置键（例如 `capture.undoLog`，
  // 那是撤销功能的数据）—— 白名单的意义正是把能力收窄到具体动作。
  // 服务层对它有范围校验（0–23），因此脏输入进不来。
  system: ['getSettings', 'setDayBoundaryHour', 'backup', 'integrityCheck', 'parseDueInput',
    'trashOverview', 'restoreIgnored', 'purgeIgnored', 'restoreTrash', 'purgeTrash'],
};

/**
 * 打包后界面与 API **不同源**，必须放行 CORS。
 *
 * | | 来源 |
 * | --- | --- |
 * | 界面（打包后） | Tauri 的应用协议 |
 * | API（始终） | `http://127.0.0.1:<port>` |
 *
 * 浏览器规则要求跨源请求由服务端返回 CORS 头，WebView2 同样适用。
 * 不加的后果是**所有数据请求被拒**，而界面本身能打开 —— 表现为"界面是空的"。
 *
 * **为什么放行全部来源而不是白名单**：服务只监听 `127.0.0.1`，
 * 外部本来就不可达；能发起请求的只有本机进程。加白名单会引入
 * "Tauri 在各平台的源不同"这种平台细节，收益为零、维护成本却真实存在。
 * 这与"本地服务也要有基本防线"不冲突 —— 那道防线是**只绑回环地址**。
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { ...CORS_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`);
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 解析并校验静态文件路径。
 * 先拼接再 realpath，确保解析后的真实路径仍在 STATIC_DIR 内——
 * 这样 `..` 与符号链接两种逃逸都挡得住。
 */
function resolveStaticFile(urlPath: string): string | null {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (relative.includes('\0')) return null;

  const candidate = resolve(STATIC_DIR, relative);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }

  const rootReal = realpathSync(STATIC_DIR);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;

  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function serveStatic(response: ServerResponse, filePath: string): void {
  const body = readFileSync(filePath);
  const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, {
    'content-type': mime,
    'content-length': body.length,
    // no-cache（而非 no-store）= 每次都必须向服务端校验。
    // 本地服务重校验几乎无成本，却能避免"改了前端代码、浏览器还在跑旧版"
    // 这类极难定位的问题——本项目已经因此被误导过一次。
    'cache-control': 'no-cache',
    ...CORS_HEADERS,
  });
  response.end(body);
}

/** 白名单校验 + 参数形状检查 */
function validate(request: ApiRequest): void {
  const methods = ALLOWED[request.service];
  if (methods === undefined) {
    throw new Error(`未知服务「${request.service}」，可用：${Object.keys(ALLOWED).join(' / ')}`);
  }
  if (!methods.includes(request.method)) {
    throw new Error(`服务 ${request.service} 不允许调用方法「${request.method}」`);
  }
  if (request.params !== undefined && request.params !== null
    && typeof request.params !== 'object') {
    throw new Error('params 必须是对象或数组');
  }
}

/**
 * 把请求参数转成位置参数列表。
 *
 * 约定：params 是**数组**时按位置展开；是**对象**时整体作为第一个参数。
 * 因此无参方法必须传 `[]` 而不是 `{}`——传 `{}` 会被当成一个位置参数，
 * 落进 `backup('reason')` 这类方法就变成字符串 "[object Object]"。
 * 界面侧的 api.js 已按此约定编写。
 */
function toArguments(params: unknown): unknown[] {
  if (params === null || params === undefined) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

export function createAppServer(options: ServerOptions): Server {
  const { database, services, port, verbose = false } = options;

  return createServer((request, response) => {
    void handle(request, response, database, services, verbose).catch((error: unknown) => {
      if (isDomainError(error)) {
        sendJson(response, 400, { ok: false, code: error.code, message: error.message });
        return;
      }
      // 非领域错误也要把消息带上：空消息的 400 让人完全无从排查
      const message = error instanceof Error ? `${error.message}` : String(error);
      sendJson(response, 400, { ok: false, code: 'REQUEST_FAILED', message });
    });
  });

  function handle(
    request: IncomingMessage,
    response: ServerResponse,
    db: DatabaseSync,
    svc: WorkHelperServices,
    log: boolean,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);

    if (log) console.log(`${request.method ?? 'GET'} ${pathname}`);

    // CORS 预检：`content-type: application/json` 的 POST 属"非简单请求"，
    // 浏览器会先发 OPTIONS 问一句。不回应它，正式请求根本不会发出 ——
    // 表现为所有数据请求静默失败。不需要带 body，也不该走白名单校验。
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...CORS_HEADERS, 'content-length': 0 });
      response.end();
      return Promise.resolve();
    }

    if (pathname.startsWith('/api/')) {
      return handleApi(request, response, svc, pathname);
    }

    /**
     * 告诉前端"API 在哪"。
     *
     * 打包后界面由 Tauri 的应用协议提供、API 在本地 HTTP 服务上，**两者不同源**，
     * 前端无法用相对路径找到 API。与其把端口写死两份（改一处必漏一处），
     * 不如让服务自己报出来 —— **端口只在本文件顶部定义一次**。
     */
    if (pathname === '/api-base') {
      sendJson(response, 200, { base: `http://127.0.0.1:${port}` });
      return Promise.resolve();
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, '只支持 GET');
      return Promise.resolve();
    }

    // 快记窗的地址是 /capture，主界面是 /
    const filePath = resolveStaticFile(pathname === '/capture' ? '/capture.html' : pathname);
    if (filePath === null) {
      sendText(response, 404, `找不到 ${pathname}`);
      return Promise.resolve();
    }
    serveStatic(response, filePath);
    return Promise.resolve();
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    svc: WorkHelperServices,
    pathname: string,
  ): Promise<void> {
    if (request.method !== 'POST') {
      sendText(response, 405, '接口只接受 POST');
      return;
    }

    const [, , serviceName, methodName] = pathname.split('/');
    if (serviceName === undefined || methodName === undefined) {
      sendJson(response, 400, { ok: false, message: '接口路径格式应为 /api/<服务>/<方法>' });
      return;
    }

    const body = await readJsonBody(request);
    const apiRequest: ApiRequest = {
      service: serviceName,
      method: methodName,
      params: (body as { params?: unknown }).params,
    };
    validate(apiRequest);

    const target = svc[serviceName as keyof WorkHelperServices] as unknown as
      | Record<string, (...args: unknown[]) => unknown>
      | undefined;
    if (target === undefined || typeof target[methodName] !== 'function') {
      sendJson(response, 400, { ok: false, message: `服务 ${serviceName} 没有方法 ${methodName}` });
      return;
    }

    // 服务方法多数是同步的，少数（backup）返回 Promise，统一 await 即可
    const result = await Promise.resolve(target[methodName](...toArguments(apiRequest.params)));
    sendJson(response, 200, { ok: true, data: result ?? null });
  }
}

export interface StartOptions {
  port?: number;
  dataDir?: string;
  dbPath?: string;
  verbose?: boolean;
}

export interface StartedServer {
  port: number;
  dbPath: string;
  dataDir: string;
  close(): Promise<void>;
}

/** 启动服务：单实例检查 + 端口占用提示 */
export async function startServer(options: StartOptions = {}): Promise<StartedServer> {
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = options.dataDir === undefined ? defaultDataDir() : resolveFromRoot(options.dataDir);
  const dbPath = options.dbPath === undefined
    ? join(dataDir, DEFAULT_DB_FILENAME)
    : resolveFromRoot(options.dbPath);

  const database = openDatabase(dbPath);
  migrate(database);
  const services = createServices(database, { dataDir });

  const server = createAppServer({ database, services, port, verbose: options.verbose ?? false });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        rejectStart(new Error(
          `端口 ${port} 已被占用。可能已经有一个 WorkHelper 服务在运行——` +
          `请先关闭它，或用 --port 换一个端口。`,
        ));
        return;
      }
      rejectStart(error);
    });
    server.listen(port, '127.0.0.1', resolveStart);
  });

  return {
    port,
    dbPath,
    dataDir,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      closeDatabase(database);
    },
  };
}
