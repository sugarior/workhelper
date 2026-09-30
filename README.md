# WorkHelper · 工作秘书

一个常驻 Windows 桌面的个人工作秘书：**随手把任何东西丢进来**（全局热键 + 悬浮小组件），
由它（必要时借 AI）把混乱输入整理成**项目 → 任务 → 子任务**的可执行结构，
并把每次推进与每日日志沉淀成可导出的事实源。

## 当前状态

**M0 全部实现完毕（T1–T9）**：内核、服务层、命令行、**图形界面**都已就绪，212 项测试通过。
剩下的只有验收本身——连续 3 天真实使用。

**零依赖、零构建**：`dependencies` 为空，不需要 `npm install`，也不需要编译
（Node 26 原生运行 TypeScript，内置 `node:sqlite`，`node_modules` 不存在）。

## 用界面

```bash
node src/ui/main.ts
```

然后打开 <http://127.0.0.1:7317>。服务只监听 `127.0.0.1`，不对局域网开放。

| 页面 | 用途 |
| --- | --- |
| 主界面 `/` | **全部**（所有未结束任务，六组：逾期/今天到期/进行中/卡住/已排期/没有排期）、收件箱（多选 + 转任务/**转项目**/存资料/丢弃/删除 + 撤销，低频动作在 `更多 ▾` 里且各带一行说明）、今日（四组 + 行内记一笔 + "还有 N 条不在这里"的指引）、项目（三级树 + 进展时间线）、日志（自动汇总 + 手写正文） |
| 快记窗 `/capture` | 打开即聚焦，`Enter` 保存、`Shift+Enter` 换行、`Esc` 取消；识别到日期会显示浅色截止标签 |

**顶部有两个计数徽标**：收件箱积压数、未结束任务总数（有逾期时转红）。
这是需求 §6.6 的可见性约束——未结束任务数必须常驻可见，否则"零门槛捕获"会变成"零门槛丢事"。

**规划中**（需求已确认，待实现）：

| 功能 | 说明 |
| --- | --- |
| **已完成总览**（F-09b） | 「全部」页签内切换，按完成日分组、带项目名与父任务名，时间范围 7 天 / 全部 / 自定义 |
| **资料模块**（F-11~F-14） | 工作区指针，**必须挂靠**任务/项目，可从任务多选一键打开 |
| **回收站界面**（F-21b） | 右上角入口，含「已删除（30 天后清理）」与「已丢弃（不过期）」两个筛选，可恢复/放回/彻底删除 |
| 托盘 + 悬浮组件 + 全局热键 | M1，需 Tauri 与 Rust 工具链 |

详见[后续工作计划](docs/plan-next-steps.md)。

界面内快捷键：`Ctrl+K` 聚焦搜索，`Ctrl+Alt+Space` 打开快记窗（**仅浏览器内有效**）。

**桌面快捷方式（过渡方案）**：全局热键要等 M1 的 Tauri 外壳。在那之前可以跑

```powershell
pwsh -File scripts\setup-shortcuts.ps1
```

它会在桌面生成「WorkHelper 快记」，双击即自动拉起服务并打开快记窗。
**这不是全局热键**——不能在任何程序里一按就出。M1 完成后该脚本即可删除。

## 用命令行

数据默认存在 `<项目根>/data`（相对路径的解释基准是项目根，不随当前目录变化）。

```bash
# 随手记一句（自动识别「下周三」「明天」等日期）
node src/cli/wh.ts add "接口文档 下周三 给张三"

# 看收件箱、转成任务
node src/cli/wh.ts inbox
node src/cli/wh.ts task <id> --priority high
node src/cli/wh.ts undo              # 分错了可以撤销

# 今天做什么
node src/cli/wh.ts today

# 推进：开始 / 记一笔 / 卡住 / 解除 / 完成
node src/cli/wh.ts doing <id>
node src/cli/wh.ts note <id> "已完成初稿"
node src/cli/wh.ts note <id> 卡点 "等法务确认"    # 状态会自动联动为 blocked
node src/cli/wh.ts unblock <id>
node src/cli/wh.ts done <id> --cascade

# 项目与子任务
node src/cli/wh.ts proj add "Q3 数据平台迁移" --goal "完成迁移"
node src/cli/wh.ts sub <任务id> "盘点现有表"
node src/cli/wh.ts proj show <项目id>

# 日志与检索
node src/cli/wh.ts log                        # 今日自动汇总
node src/cli/wh.ts log 2026-09-20 "补录的正文"
node src/cli/wh.ts search 文档                # 中文子串可搜

# 系统
node src/cli/wh.ts backup                     # 备份 + 轮换
node src/cli/wh.ts trash list                 # 回收站
node src/cli/wh.ts verify                     # 结构与业务自检
node src/cli/wh.ts status
node --test tests/                            # 全部测试
```

ID 支持短前缀（像 git 一样，最少 4 位，歧义时会列出候选）。
所有命令都支持 `--json`，便于脚本处理。

## 文档

| 文档 | 内容 |
| --- | --- |
| [后续工作计划](docs/plan-next-steps.md) | 从当前状态到「初步体验」的四步：页面 → 全局热键 → 常驻 → 验收，含依赖、风险与检查点 |
| [需求与目标文档](docs/requirements.md) | 背景问题、目标/非目标、使用场景、概念模型、功能需求（P0/P1/P2）、交互契约、技术方案、里程碑、决策状态、环境状态 |
| [技术设计文档](docs/design.md) | 三层架构与分层纪律、目录结构、完整 SQLite DDL、4 点切日算法、内核服务接口、M0 界面契约、AI 拆分契约、备份策略、测试策略、任务清单、**设计验证记录** |
| [已有方案调研与选型对比](docs/research-existing-solutions.md) | 27 个同类产品/开源项目的横向对比、同类产品普遍失败点、自研缺口、对本项目的启示 |

## 一句话结论

开源生态里**不存在**「Windows 常驻秒级捕获 + AI 任务拆解 + 本地单一事实源」三合一方案，
因此自研核心（捕获 / 拆分 / 存储），外围借鉴 Backlog.md 式「Markdown 导出 + 可选 Git」作为数据出口。

## 开工前的环境状态

| 项 | 状态 |
| --- | --- |
| DSH 文件沙箱 | ✅ 已解决 —— 原 `SetNamedSecurityInfoW failed (Win32 5)` 源于账户是 UAC 过滤令牌、沙箱无法改工作区 DACL；会话切至 `danger-full-access` 后绕过 |
| Node.js v26.10.0 / WebView2 153 / npm 11.19.1 / git 2.45.1 | ✅ 已就位 |
| `node:sqlite` 内置模块 | ✅ 实测可用 → **零原生编译依赖** |
| Rust + MSVC 生成工具 | ❌ 缺失，**M1 接桌面壳前**安装（M0 不需要） |
| PowerShell 执行策略 | ⚠️ 全 `Undefined`，需 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 才能用 `npm.ps1`/`pnpm.ps1` |

详见[需求文档 §11 环境状态](docs/requirements.md)。
