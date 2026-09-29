// 本机未安装 typescript 与 @types/node（为保持 node_modules 为空，
// 不引入任何包）。此处只声明本项目真实用到的 Node 内置能力，
// 供编辑器提示与类型检查使用；运行时不参与任何行为。
// 声明与 Node 26 实际行为一一对应（已实测，见 docs/design.md §13）。

declare module 'node:sqlite' {
  export type SqlValue = string | number | bigint | null | Uint8Array;

  export interface StatementResultingChanges {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    all(...params: SqlValue[]): unknown[];
    get(...params: SqlValue[]): unknown;
    run(...params: SqlValue[]): StatementResultingChanges;
    iterate(...params: SqlValue[]): IterableIterator<unknown>;
    columns(): { column: string | null; name: string; type: string | null }[];
    setReadBigInts(enabled: boolean): void;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    timeout?: number;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    isTransaction: boolean;
  }

  /** 在线备份：把 source 完整复制到 path（Node 26 起可用）。 */
  export function backup(
    source: DatabaseSync,
    path: string,
    options?: { rate?: number; progress?: (info: { totalPages: number; remainingPages: number }) => void },
  ): Promise<number>;
}

declare module 'node:sqlite' {
  /** node:sqlite 抛出的错误：errcode 1 = SQL 逻辑错误（含约束冲突） */
  export interface SqliteError extends Error {
    code?: string;
    errcode?: number;
    errstr?: string;
  }
}

declare module 'node:fs' {
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isFile(): boolean; isDirectory(): boolean }[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): { size: number; isFile(): boolean };
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
  export function appendFileSync(path: string, data: string, encoding?: 'utf8'): void;
  export function realpathSync(path: string): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:util' {
  export interface ParseArgsOptionDescriptor {
    type: 'string' | 'boolean';
    short?: string;
    multiple?: boolean;
    default?: string | boolean | string[];
  }
  export interface ParseArgsConfig {
    args?: string[];
    options?: Record<string, ParseArgsOptionDescriptor>;
    allowPositionals?: boolean;
    strict?: boolean;
  }
  export interface ParseArgsResult {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
  }
  export function parseArgs(config: ParseArgsConfig): ParseArgsResult;
}

// 全局对象：只声明本项目用到的成员
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  cwd(): string;
  platform: string;
  version: string;
  execPath: string;
  on(event: 'SIGINT' | 'SIGTERM' | 'exit', listener: () => void): void;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

declare const performance: { now(): number };
declare const setTimeout: (fn: () => void, ms?: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;
declare const crypto: { randomUUID(): string };

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: 'hex'): string };
  };
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
  }

  export interface ServerResponse {
    statusCode: number;
    writeHead(status: number, headers?: Record<string, string | number>): this;
    write(chunk: string | Uint8Array): boolean;
    end(chunk?: string | Uint8Array): void;
    setHeader(name: string, value: string | number): void;
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    close(callback?: () => void): this;
    once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
}

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
    errno?: number;
    syscall?: string;
  }
}

declare const Buffer: {
  from(data: string | Uint8Array, encoding?: string): Buffer;
  concat(chunks: readonly Uint8Array[]): Buffer;
  byteLength(text: string): number;
};

interface Buffer extends Uint8Array {
  readonly length: number;
  toString(encoding?: string): string;
}

declare const URL: {
  new (input: string, base?: string): { pathname: string; searchParams: { get(name: string): string | null } };
};
