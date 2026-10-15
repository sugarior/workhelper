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

import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * `--src-only`：只刷新内核源码树，**不碰那 100MB 的 node.exe**。
 *
 * 为什么需要它：node.exe 只在系统 Node 升级时才需要更新，
 * 而 `src/` **每次改动内核都要同步** —— 否则打包出来的东西跑的是旧内核。
 * 每次都拷 100MB 太浪费（实测整脚本 4.1 秒，其中绝大部分是那个大文件）。
 *
 * 谁用它：`build.rs` 在每次编译前调一次，保证 `resources/src/` 与仓库一致。
 * 完整模式（不带参数）仍由人在升级 Node 时手动跑。
 */
const srcOnly = process.argv.includes('--src-only');

console.log(`模式     : ${srcOnly ? '仅刷新 src（跳过 node.exe）' : '完整'}`);

/**
 * 重建 `resources/.gitignore`。
 *
 * **为什么必须在这里主动写**：本脚本会先删掉整个 `resources/` 目录（下面 `rmSync`），
 * 那会连 `.gitignore` 一起删掉 —— 忽略规则随之消失，整个目录（含 100MB 的 node.exe）
 * 在下一次 `git add -A` 时就成了"新增文件"。
 *
 * **这不是假想**：确实发生过一次，仓库从 0.7MB 涨到 44.6MB，
 * 最后靠重写历史才清掉。只靠"记得别删"是记不住的，所以让脚本自己保证。
 */
function ensureGitignore() {
  const content = `# 资源目录是**可再生产物**，不进版本库（本文件由 prepare-resources.mjs 自动生成）。
#
#   · node/node.exe —— 从系统 Node 复制（约 100MB）
#   · src/          —— 从仓库根 src/ 复制，与已跟踪的 src/ 是同一内容的两份副本
#
# 曾经被误提交过一次（含 104MB 的 node.exe），仓库因此从 0.7MB 涨到 44.6MB，
# 后来重写历史才清掉。根因就是这个目录会被整体删除重建 —— 所以这里每次都写回。
*
!.gitignore
`;
  mkdirSync(RESOURCES, { recursive: true });
  writeFileSync(join(RESOURCES, '.gitignore'), content);
}

ensureGitignore();

// 1. Node 运行时
const nodeDir = join(RESOURCES, 'node');
mkdirSync(nodeDir, { recursive: true });
const target = join(nodeDir, 'node.exe');
if (srcOnly) {
  // 只模式不复制，但要确认它**已经在**：缺了就是打包缺件，
  // 那种错误要到用户机器上才暴露，必须在这里拦住。
  statSync(target);
  console.log(`\n[1/2] 跳过 node.exe（已存在 ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB）`);
} else {
  cpSync(node, target);
  console.log(`\n[1/2] 已复制 node.exe → ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB`);
}

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

if (srcOnly) {
  // 只模式下不重复验证 node.exe 能否运行（没动它，上一次已经验过）
  console.log('\n完成（仅 src）。');
  process.exit(0);
}

// 自检：随包的 Node 必须能跑起来（复制损坏时要在这里就发现，而不是装到用户机器上）
const bundledVersion = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim();
if (bundledVersion !== version) {
  console.error(`\n✗ 随包 Node 版本不一致：${bundledVersion} ≠ ${version}`);
  process.exit(1);
}
console.log(`随包 Node 可用：${bundledVersion}`);
console.log('\n完成。现在可以执行 cargo build / tauri build。');
