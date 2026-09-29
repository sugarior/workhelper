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
}

function parseArgs(argv: readonly string[]): CliArgs {
  let port = DEFAULT_PORT;
  let dataDir: string | undefined;
  let verbose = false;

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
    } else if (arg === '--data') {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`WorkHelper 图形界面服务

用法：node src/ui/main.ts [选项]

  --port <端口>    监听端口，默认 ${DEFAULT_PORT}
  --data <目录>    数据目录，默认 <项目根>/data
  --verbose        打印每个请求
  --help           显示本帮助

服务只监听 127.0.0.1，不对局域网开放。
`);
      process.exit(0);
    } else {
      throw new Error(`未知参数「${arg}」，用 --help 查看用法`);
    }
  }
  return dataDir === undefined ? { port, verbose } : { port, dataDir, verbose };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await startServer(args);

  const base = `http://127.0.0.1:${server.port}`;
  console.log(`WorkHelper 界面服务已启动`);
  console.log(`  主界面   ${base}/`);
  console.log(`  快记窗   ${base}/capture`);
  console.log(`  数据库   ${server.dbPath}`);
  console.log(`  数据目录 ${server.dataDir}`);
  console.log('');
  console.log('按 Ctrl+C 停止服务。');

  const shutdown = (): void => {
    console.log('\n正在停止服务…');
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
