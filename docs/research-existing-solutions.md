# 已有方案调研与选型对比

| 项目 | 内容 |
| --- | --- |
| 目的 | 回答"这件事是否已有现成工具可改造/自托管"，为自研决策提供依据 |
| 方法 | 网络检索 + 抓取厂商页 / GitHub 仓库（本次会话，2026-09） |
| 结论摘要 | **开源侧不存在"Windows 常驻捕获 + AI 任务拆解 + 本地单一事实源"三合一方案**，因此核心自研，外围复用 |

> 说明：星标数、价格、许可证为抓取当次的值，会随时间变化；标注「未验证」表示未取得一手证据。

---

## 1. 经典 GTD / 待办

| 产品 | 形态 | 存储 | 核心能力 | 开源/许可 | API·自动化 | 主要短板 |
| --- | --- | --- | --- | --- | --- | --- |
| [Todoist](https://developer.todoist.com/) | 桌面/Web/移动 | 纯 SaaS | 快速添加、子任务、看板、提醒 | ✗ | REST API + [官方 MCP/CLI](https://www.todoist.com/help/todoist/todoist-and-ai/use-todoist-in-claude-code-b1USJ4HB3) | 数据在云；复杂拆解弱；AI 需订阅 |
| [TickTick 滴答清单](https://ticktick.com/features) | 桌面/Web/移动 + [桌面便签](https://help.ticktick.com/articles/7055780431722971136) | 云 SaaS | 清单/看板/日历/番茄/习惯，中文体验最佳 | ✗ | 开放 API（社区 [MCP](https://github.com/Code-MonkeyZhang/ticktick-mcp-enhanced)），官方 MCP 未验证 | 云端锁定、离线弱；无 AI 任务拆解 |
| [Things 3](https://uk.pcmag.com/productivity/141616/things-3) | 仅 Apple | 本地 + CloudKit | 今天/即将、项目、清单 | ✗ | 无官方 API | Windows 不可用；无 AI；扩展性差 |
| [Microsoft To Do](https://learn.microsoft.com/en-us/answers/questions/5701445/how-do-you-assign-tasks-in-the-new-version-of-outl) | 桌面/Web | 云 | 我的一天、步骤、提醒 | ✗ | Graph API | 被 Planner 取代降级；[重复任务缺陷长期未修](https://learn.microsoft.com/en-au/answers/questions/5625640/to-do-recurring-tasks-still-not-resolved)；无 AI 拆解 |
| [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) | 编辑器插件 | 本地 Markdown | 查询引擎、截止/计划/重复、依赖 | ✓ MIT | Tasks API；[obsidian-tasks-mcp](https://github.com/hairyhenderson/obsidian-tasks-mcp) | 官方[已知限制](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/docs/Support%20and%20Help/Known%20Limitations.md)：仅单行条目、元数据解析脆弱、无原生提醒/看板 |

## 2. 开源 / 可自托管

| 项目 | 形态 | 存储 | 许可 | 亮点 | 短板 |
| --- | --- | --- | --- | --- | --- |
| [Vikunja](https://github.com/go-vikunja/vikunja) | 自托管 Web + 桌面 | 服务端 DB（SQLite/PG） | AGPL-3.0（desktop GPL-3.0） | 清单/看板/甘特/CalDAV、OpenAPI | 个人部署重；无内置 AI；桌面端较薄 |
| [Focalboard](https://github.com/mattermost-community/focalboard) | 自托管 Web/桌面 | 服务端 DB | 自定义(Mattermost) | 看板+表格+日历 | 已转社区维护、活跃度下降；无 AI 与子任务拆解 |
| [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy) | 桌面优先 | 本地优先（可选云） | AGPL-3.0 | 数据库/看板/日历/AI、协作 | 偏 Notion 级文档；快速捕获与个人 GTD 流程弱 |
| [Logseq](https://github.com/logseq/logseq) | 桌面/移动 | 本地 Markdown/Org；2.0 DB 版 | AGPL-3.0 | **每日日记是一等公民**、块引用、任务状态、可自托管同步 | 历史性能与版本迁移顾虑；AI 需外挂 |
| [Super Productivity](https://github.com/super-productivity/super-productivity) | 桌面/Web/移动 | **本地优先**，多后端可选 | MIT | 子任务+看板+日历导入+时间盒、插件、[本地 REST API](https://github.com/super-productivity/super-productivity/wiki/3.01-API) | UI 信息密度高、open issues 多；[本地文件模式不适合多设备](https://github.com/super-productivity/super-productivity/wiki/3.08-Sync-Integration-Comparison)；**无 AI 拆解** |
| [dooit](https://github.com/dooit-org/dooit) | TUI（CLI） | 本地文件 | MIT | 终端极速登记、子任务树、可脚本化 | 无 GUI / 常驻便签 / 提醒 |

## 3. AI 原生 / AI 增强

| 产品 | 价格（抓取当次） | AI 能力 | 短板（个人视角） |
| --- | --- | --- | --- |
| [Motion](https://www.usemotion.com/legal/terms-of-service) | 个人 Pro AI 年付 $29/月、月付 $49 | 自动排程、项目/文档、AI credits 计量 | 纯 SaaS 无本地；条款明写年付不退；自动安排常与真实意图错位 |
| [Reclaim.ai](https://reclaim.ai/pricing) | 免费版 + 付费档（约 $10–18，**未逐项验证**） | 任务自动占位、习惯、缓冲、AI Assistant | 依附 Google/Outlook 日历；数据在云；不解决拆分与登记 |
| [Sunsama](https://help.sunsama.com/docs/billing/overview/) | $22/月 | 日计划/时间盒、Sunny AI、MCP、全量集成 | 官方文档明示：取消后 **30 天删除数据**；无本地模式 |
| [Akiflow](https://akiflow.com/pricing) | Pro $34/月，年付 $19/月 | Aki 助手、**托管 MCP** | 无免费版、试用绑卡；合规认证未验证 |
| [Taskmaster](https://github.com/eyaltoledano/claude-task-master) | 开源 + 自带 Key | PRD→任务树、复杂度分析、依赖 | **MIT + Commons Clause**（禁转售/托管）；面向开发者任务而非个人工作 |
| [local-ai-task-manager](https://github.com/ceymab/local-ai-task-manager) | 免费 | 本地 Ollama 自然语言问答 | 极早期项目；无桌面常驻（代表性有限） |

## 4. 轻量桌面便签 / 快速捕获

| 方案 | 形态/存储 | 短板 |
| --- | --- | --- |
| Windows Sticky Notes | 系统便签；已并入 OneNote 体系 | 纯文本、无拆分/提醒/查询；云+账户绑定 |
| [Pin-Notes](https://github.com/AleenaTahir1/Pin-Notes) / [BetterStickies](https://github.com/HimaSphere/BetterStickies) | Windows 悬浮置顶便签、本地、免账户 | 早期项目、无生态、无结构化任务、缺 LICENSE |
| TickTick 桌面便签 | 客户端内置悬浮便签 + 全局快速添加 | 仍绑云账户；AI 弱（页面正文为空，**细节未验证**） |
| [Raycast](https://www.raycast.com/changelog/windows/2-0)（Windows 2.0） | 启动器 + Notes + AI + Dictation + MCP | 非任务数据库（无项目/子任务树/复盘）；AI 属 Pro |
| [Fluent Search](https://www.fluentsearch.net/docs/Search%20apps/To%20Do) | 启动器，可读 Microsoft To Do | 只是入口不拥有数据；无 AI 拆分 |

---

## A. 同类产品普遍做不好的六点

1. **维护成本 > 收益**：全量捕获变成"关于工作的额外工作"，最终弃用（[GTD 失败复盘](https://www.calendar.com/blog/why-gtd-failed-me-a-digital-productivity-experts-perspective/)）。
2. **只解决"记下来"，不解决"拆开"**：捕获与分解之间没有桥，清单越攒越废。
3. **AI 排程不可信**：自动改期/重排带来失控感，且要长期订阅（Motion 年付不退、积分计量）。
4. **AI 拆解能力几乎缺位**：现有 AI 多用于"自然语言→单条任务/排程"，而非"一句话→任务树+依赖+验收标准"，且数据必须上云。
5. **数据主权是结构性冲突**：好用的都是云或平台锁定；能自托管的缺 AI 与随手捕获。
6. **提醒/重复任务/离线同步是长期 bug 温床**：如 MS To Do 重复任务、Obsidian Tasks 的解析限制。

## B. 自研必须补齐的缺口

1. **秒级常驻捕获**：全局热键 + 托盘/悬浮便签 + 无焦点抢占录入 + 剪贴板/选中文本入队——开源侧没有"Windows 常驻浮窗 + 结构化任务"二合一。
2. **AI 拆分内核**：自然语言 → 任务树（子任务/依赖/预估/验收标准），流式预览与一键撤销，模型可切换；现有 MCP 任务项目只覆盖"开发任务"语义。
3. **本地单一事实源**：SQLite + Markdown 导出 + 可选 Git 版本化；Super Productivity 最接近但仍为私有 ops 格式。
4. **日志 ↔ 任务双向绑定**：每日日志自动汇总当日完成/顺延/新增并生成周回顾；Obsidian Tasks 仅支持单行条目。
5. **Windows 工程细节**：多显示器、DPI/输入法、开机自启、更新——商业工具做了，开源便签基本没做。

## C. 面向 AI Agent 的任务管理 / MCP 项目（已核实存在）

| 项目 | 形态 | 存储 | 许可 |
| --- | --- | --- | --- |
| [Taskmaster](https://github.com/eyaltoledano/claude-task-master) | CLI + MCP server | `.taskmaster/` 本地 JSON | MIT **+ Commons Clause** |
| [Backlog.md](https://github.com/MrLesk/Backlog.md) | CLI + 终端看板 + 本地 Web UI + MCP | 仓库内 Markdown（Git 可选） | MIT |
| [obsidian-tasks-mcp](https://github.com/hairyhenderson/obsidian-tasks-mcp) | 独立 MCP，解析 Obsidian Tasks | 本地 Markdown | MIT（早期） |
| [fxstein/ai-todo](https://github.com/fxstein/ai-todo) | Agent 原生 CLI/技能，Git 版本化 | 仓库内文件 | Apache-2.0 |
| Todoist 官方 MCP / Akiflow 托管 MCP | 商业 SaaS 的 MCP 端点 | 云 | 闭源 |

**要点**：现有 MCP 任务项目几乎都面向**代码仓库**（Markdown/JSON + Git），而不是个人工作秘书场景。可借鉴的是其**协议思路**（纯文本可读、Git 可版本化、对外暴露安全子集），而不是直接复用其数据模型。

---

## D. 对本项目的启示（结论）

| 结论 | 对应需求文档条目 |
| --- | --- |
| 无现成方案覆盖 70%，自研核心；但数据出口采用 Markdown + 可选 Git | §2.1、§7.1、附录 A-1 |
| "收件箱清空流程"与"AI 拆分"是核心而非附加功能 | F-04、F-20 |
| AI 只做建议、人工确认，明确排除全自动排期 | F-20、§2.2、附录 A-3 |
| 常驻捕获（热键 + 悬浮窗 + 托盘）本身就是差异化能力，必须做到极致低延迟 | F-01、F-12、F-13、§6 |
