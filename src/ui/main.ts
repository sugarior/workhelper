#!/usr/bin/env node
// 图形界面服务的启动入口。
// 界面与内核的连接只有一条：createServices() 暴露的服务门面——
// 本文件不直接碰数据库，也不包含任何业务规则。

import { startServer, DEFAULT_PORT } from './server.ts';
import { isDomainError } from '../core/domain/errors.ts';

interface CliArgs {
  port: number;
  dataDir?: string;
  verbose: boolean;
  /**
   * 宿主进程 PID（Tauri 外壳传入）。
   *
   * **为什么需要它**：Windows 上**没有"父进程死了子进程跟着死"的默认行为**。
   * 外壳被强杀（崩溃、任务管理器结束）时，它自己的退出处理根本不会执行，
   * 于是这个服务会变成孤儿：一直占着端口、一直吃内存。
   * 实测确认过这个现象（B2-a 实验）。
   *
   * 传入后本进程会盯着宿主，宿主一消失就自行退出。**不传则完全不启用**，
   * 因此独立运行 `node src/ui/main.ts` 的行为一个字都没变。
   */
  parentPid?: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let port = DEFAULT_PORT;
  let dataDir: string | undefined;
  let verbose = false;
  let parentPid: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[i + 1];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`--port 需要一个 1–65535 的整数，收到「${value ?? ''}」`);
      }
      port = parsed;
      i += 1;
    } else if (arg === '--parent-pid') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--parent-pid 需要一个正整数，收到「${argv[i + 1] ?? ''}」`);
      }
      parentPid = value;
      i += 1;
    } else if (arg === '--data') {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`WorkHelper 图形界面服务

用法：node src/ui/main.ts [选项]

  --port <端口>      监听端口，默认 ${DEFAULT_PORT}
  --data <目录>      数据目录，默认 <项目根>/data
  --parent-pid <pid> 宿主进程 PID；它退出后本进程随之退出（桌面外壳用）
  --verbose          打印每个请求
  --help             显示本帮助

服务只监听 127.0.0.1，不对局域网开放。
`);
      process.exit(0);
    } else {
      throw new Error(`未知参数「${arg}」，用 --help 查看用法`);
    }
  }
  const base = { port, verbose };
  return {
    ...base,
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(parentPid === undefined ? {} : { parentPid }),
  };
}

/**
 * 宿主进程看门狗：宿主消失就自杀。
 *
 * 用 `process.kill(pid, 0)` 探测存活 —— 它不发信号，只做存在性检查，
 * 不存在时抛 `ESRCH`。这是 Node 里唯一不需要额外依赖的做法。
 *
 * **必须 `unref()`**：定时器若把事件循环钉住，服务就无法正常退出。
 */
function watchParent(parentPid: number): void {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log(`\n宿主进程 ${parentPid} 已退出，本服务随之退出。`);
      process.exit(0);
    }
  }, 2000);
  timer.unref();
}


async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await startServer(args);

  const base = `http://127.0.0.1:${server.port}`;
  console.log(`WorkHelper 界面服务已启动`);  console.log(`  主界面   ${base}/`);
  console.log(`  快记窗   ${base}/capture`);
  console.log(`  数据库   ${server.dbPath}`);
  console.log(`  数据目录 ${server.dataDir}`);
  if (args.parentPid !== undefined) {
    console.log(`  宿主 PID ${args.parentPid}（它退出后本服务自动退出）`);
  }
  console.log('');
  console.log('按 Ctrl+C 停止服务。');

  const shutdown = (): void => {
    console.log('\n正在停止服务…');
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 宿主管辖（桌面外壳传入 --parent-pid 时启用）：
  // 外壳被强杀时本进程不能变成孤儿，否则端口与内存一直被占。
  if (args.parentPid !== undefined) {
    watchParent(args.parentPid);
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
