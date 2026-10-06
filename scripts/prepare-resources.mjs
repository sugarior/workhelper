// 准备 Tauri 的资源目录：把 Node 运行时与内核源码树放进 resources/。
//
// 为什么需要这一步：打包后目标机器**没有 Node**，因此必须随包。
// 见 docs/plan-next-steps.md §4.1（用户确认"自带 Node"）。
//
// 用法：node scripts/prepare-resources.mjs
//
// 为什么不做成构建时自动执行：拷贝 100MB 每次构建都做一遍太浪费，
// 而这部分内容**只在系统 Node 升级或内核代码改动时才需要更新**（内核那部分只有 439KB，
// 且当前由 Tauri 直接从 resources/src 打包）。做成显式命令，构建快、行为可预期。

import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = join(REPO_ROOT, 'shell', 'src-tauri', 'resources');

/** 找到系统 node 可执行文件的绝对路径 */
function findSystemNode() {
  // process.execPath 就是当前正在运行的 node —— 比查 PATH 更可靠
  return process.execPath;
}

const node = findSystemNode();
const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();

console.log(`Node     : ${node}`);
console.log(`版本     : ${version}`);
console.log(`资源目录 : ${RESOURCES}`);

// 1. Node 运行时
const nodeDir = join(RESOURCES, 'node');
mkdirSync(nodeDir, { recursive: true });
const target = join(nodeDir, 'node.exe');
cpSync(node, target);
console.log(`\n[1/2] 已复制 node.exe → ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB`);

// 2. 内核源码树。
//    Node 26 直接运行 .ts（类型剥离），**不需要任何构建步骤、也没有 node_modules 依赖** ——
//    这一点已实测确认（把 src/ 复制到别处用同一份 Node 即可独立运行）。
//    先删后拷，避免源树里删掉的文件残留在资源目录里。
const srcDir = join(RESOURCES, 'src');
rmSync(srcDir, { recursive: true, force: true });
cpSync(join(REPO_ROOT, 'src'), srcDir, { recursive: true });
console.log(`[2/2] 已复制 src/ → ${srcDir}`);

// 自检：入口必须存在，否则打包出来的东西启动就报错
const entry = join(srcDir, 'ui', 'main.ts');
statSync(entry);
console.log(`\n入口确认 : ${entry}`);

// 自检：随包的 Node 必须能跑起来（复制损坏时要在这里就发现，而不是装到用户机器上）
const bundledVersion = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim();
if (bundledVersion !== version) {
  console.error(`\n✗ 随包 Node 版本不一致：${bundledVersion} ≠ ${version}`);
  process.exit(1);
}
console.log(`随包 Node 可用：${bundledVersion}`);
console.log('\n完成。现在可以执行 cargo build / tauri build。');
