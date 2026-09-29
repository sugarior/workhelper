# WorkHelper · 工作秘书

一个常驻 Windows 桌面的个人工作秘书：**随手把任何东西丢进来**（全局热键 + 悬浮小组件），
由它（必要时借 AI）把混乱输入整理成**项目 → 任务 → 子任务**的可执行结构，
并把每次推进与每日日志沉淀成可导出的事实源。

## 当前状态

**M0 已可用（T1–T7、T9 完成）**：内核、服务层、命令行全部就绪，212 项测试通过。
界面（T8）待做，但**现在就可以开始真实使用**并计时"连续 3 天"的 M0 验收。

**零依赖、零构建**：`dependencies` 为空，不需要 `npm install`，也不需要编译
（Node 26 原生运行 TypeScript，内置 `node:sqlite`，`node_modules` 不存在）。

## 快速上手

数据默认存在 `data/`。第一次运行会自动建库。

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
