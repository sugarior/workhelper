# WorkHelper · 工作秘书

一个常驻 Windows 桌面的个人工作秘书：**随手把任何东西丢进来**（全局热键 + 悬浮小组件），
由它（必要时借 AI）把混乱输入整理成**项目 → 任务 → 子任务**的可执行结构，
并把每次推进与每日日志沉淀成可导出的事实源。

## 下载

**[工作秘书 安装包（Windows x64）](https://github.com/sugarior/workhelper/releases/latest)**
—— 按用户安装，**不需要管理员权限**；装完常驻托盘。

| 要求 | 说明 |
| --- | --- |
| 系统 | Windows 10 / 11 x64（需 WebView2 运行时，Windows 11 自带）|
| 数据位置 | `%APPDATA%\WorkHelper\data\workhelper.db` —— **单一 SQLite 文件，完全本地，不联网** |

> **这是个人工具**，界面与交互是按我自己的工作方式做的，可能不适合所有人。
> 已知限制见 [Release 说明](https://github.com/sugarior/workhelper/releases/latest)，
> 其中最实际的一条：**常驻内存约 590MB**（WebView2 每个窗口一套渲染进程的固有开销）。

想从源码跑、或改代码，见 [开发环境搭建](docs/development-setup.md)。

## 当前状态

**M1 已完成**：M0 的内核 + 图形界面之上，桌面外壳（Tauri 2）已具备

| 能力 | 说明 |
| --- | --- |
| **全局热键** | `Ctrl+Alt+Space` 快记、`Ctrl+Shift+Space` 记一笔（在任何程序里都能按） |
| **系统托盘** | 左键呼出主界面、右键菜单（快记 / 今日 / 收件箱 / 显示隐藏组件 / 设置 / 退出）；**关主窗口不退出进程** |
| **桌面悬浮组件** | 半透明、可拖动、置顶、可调不透明度；显示今日待办 + 收件箱未处理数 + 当前进行中的任务 |
| **开机自启** | 设置页开关，写当前用户注册表（**不需要管理员权限**） |
| **设置页** | 每日切日时刻、悬浮组件显隐与不透明度、开机自启、快捷键（只读） |
| **安装包** | NSIS 安装器，按用户安装、不需要管理员 |

**344 项内核测试通过**，`node src/cli/wh.ts verify` 业务自检干净。

**零依赖、零构建**：`dependencies` 为空，不需要 `npm install`，也不需要编译
（Node 26 原生运行 TypeScript，内置 `node:sqlite`，`node_modules` 不存在）。
桌面外壳部分需要 Rust，但**只有要重新打包时才需要**。

## 两种运行方式

### 直接用（开发态，需要 Node 26+）

```bash
node src/ui/main.ts
```

然后打开 <http://127.0.0.1:7317>。服务只监听 `127.0.0.1`，不对局域网开放。

这一方式**没有**全局热键、托盘与悬浮组件 —— 那些在桌面外壳里。

### 桌面外壳（开发态）

```bash
cd shell/src-tauri
cargo run
```

**开发态会保留一个命令行窗口** —— 它是排查的主要依据（"内核已就绪，耗时 …" 这类日志
都从这里看）。按构建类型分开处理：发布态不显示它。

### 安装包

```bash
cd shell/src-tauri
cargo tauri build     # 需要 cargo install tauri-cli --version '^2'
```

产物：`<target-dir>/release/bundle/nsis/工作秘书_<版本>_x64-setup.exe`

## 功能一览

| 页面 | 用途 |
| --- | --- |
| 主界面 `/` | **全部**（页内切换「全部未结束」/「已完成」/「已中止」；未结束侧六组：逾期/今天到期/进行中/卡住/已排期/没有排期，每个任务带可折叠的 `📎 资料 N 条`）、收件箱（工具栏 `转任务 / 存为资料 / 忽略 / 转项目 / 撤销`，行内同名四个按钮，**全部在第一层**）、今日、**资料**、项目、日志、**设置** |
| **资料** | 按时间倒序列出，可筛「全部 / 未挂靠」，可改挂靠、多选打开、复制路径。资料只存**指针**（路径 / 网址 / 或一段指向实物的文字），**必须挂靠**任务或项目 |
| **快记窗** `/capture` | 打开即聚焦，`Enter` 保存、`Shift+Enter` 换行、`Esc` 取消；选「资料」芯片可**粘贴多行**，每行一个入口（识别不出路径的行会成为「文字入口」，不会被丢掉）。**空内容按 `Enter` 直接关闭** |
| **回收站**（右上角入口） | 页内两个分类：**已忽略**（收件箱条目，可放回待处理，**不过期**）/ **已删除**（**资料**，可恢复，30 天后清理）。两者都可「彻底删除」——全系统唯一不可逆操作，**必须二次确认** |
| **搜索** | `Ctrl+K` 聚焦搜索框；中文子串可搜。**结果可点击定位** —— 跳到该实体所在页面、滚动到视野、短暂高亮。暂不支持定位的类别会明说，而不是点了没反应 |

**任务可以修改**：任务行的「更多 ▾」里有「中止（不做了）/ 改截止日 / 优先级 / 预估时长」。
截止日支持 `2026/10/8`、`明天`、`下周三` 等写法，留空或写 `/` 清除；
看不懂的日期会**当场提示**而不是静默存错（`2026-02-30` 会被拒绝，不会滚成 3 月 2 日）。

**终止方式在每个层级都有**：任务用「**中止**」，项目用「**归档**」，
都表示"不做了"并**保留记录与历史进展** —— 界面**刻意不提供删除任务/项目**。

**顶部有一条焦点常驻条**：显示"当前在做哪件"并提供「记一笔」。
这是需求 §3.1「频繁被打断」的解 —— 回来后不需要回想刚才在做什么。

**顶部有两个计数徽标**：收件箱积压数、未结束任务总数（有逾期时转红）。
这是需求 §6.6 的可见性约束——未结束任务数必须常驻可见，否则"零门槛捕获"会变成"零门槛丢事"。

**焦点（当前任务）**：顶部那条的**任务名本身就是切换器** —— 点一下就能换，不必回「全部」重新点聚焦。
候选列表默认只列**今日排期的任务**（排入今日、或截止日 ≤ 今天），避免任务多时列表长到没法用；
另有两个例外：**当前焦点始终列出**（否则一旦它脱离今日，你就没法从它切走），
以及**待办任务也列出**（选中即自动开始）。
焦点**全库唯一**，且**只能落在"进行中"的任务上** —— 因此它始终意味着"这件事真的在推进"。
任务完成、卡住、放弃、或跨过日界时焦点静默清除。

> 「记一笔」（`Ctrl+Shift+Space`）与「快记」（`Ctrl+Alt+Space`）**是两件事**：
> 前者给**当前任务**追加进展，后者**新建收件箱条目**。
> 两者都能在悬浮组件上完成，且**悬浮组件绝不主动抢焦点**。

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

# 资料（界面出问题时的保底通路）
node src/cli/wh.ts material ls                # 列出资料
node src/cli/wh.ts material ls --orphan       # 只看未挂靠的
node src/cli/wh.ts material show <id>         # 入口与挂靠
node src/cli/wh.ts material open <id>         # 只打印全部入口原文（复制用）
node src/cli/wh.ts material link <id> project:<项目id>
node src/cli/wh.ts material rm <id>           # 软删除，可用 trash restore 恢复
```

ID 支持短前缀（像 git 一样，最少 4 位，歧义时会列出候选）。
所有命令都支持 `--json`，便于脚本处理。

## 目录结构

```
src/core/domain/    业务概念与规则（不依赖数据库）
src/core/db/        连接、迁移（001_init.sql … 007_*）、中文分词
src/core/repo/      仓储：所有 SQL 只出现在这里
src/core/service/   服务门面：界面与命令行共用的唯一入口
src/core/day/       日界与日期解析
src/core/paths.ts   路径解析（数据目录、项目根）
src/ui/server.ts    HTTP 接口（服务白名单 + CORS）
src/ui/static/      界面（原生 ESM，无构建步骤）
src/cli/            命令行
shell/src-tauri/    Tauri 桌面外壳（进程、窗口、热键、托盘）
tests/              内核测试
docs/               需求 / 设计 / 计划 / 调研
```

**分层纪律**：`core/domain` → `core/db` → `core/repo` → `core/service` → `ui`。
SQL 只出现在 `db/` 与 `repo/`；界面**不碰仓储**，只走服务门面。

## 数据在哪

| 形态 | 默认位置 |
| --- | --- |
| 开发态 | `<项目根>/data` |
| 安装后 | `%APPDATA%\WorkHelper\data` |

可在 `%APPDATA%\WorkHelper\config.json` 里用 `dataDir` 覆盖（**改后需重启**）。
设置页会显示当前位置与配置文件路径。

**发布态的排查线索**：`<数据目录>\workhelper.log`（发布版没有控制台，
内核的启动信息与错误都写在这里）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [**开发环境搭建**](docs/development-setup.md) | **在另一台设备上继续开发看这份** —— 按需分级的安装步骤、可复制的验证命令、必须知道的坑（含给 AI Agent 的执行清单）|
| [需求与目标文档](docs/requirements.md) | 背景问题、目标/非目标、使用场景、概念模型、功能需求（P0/P1/P2）、交互契约、技术方案、里程碑、决策状态、环境状态 |
| [技术设计文档](docs/design.md) | 三层架构与分层纪律、目录结构、完整 SQLite DDL、4 点切日算法、内核服务接口、界面契约、AI 拆分契约、备份策略、测试策略、**设计验证记录** |
| [后续工作计划](docs/plan-next-steps.md) | 落地顺序与每段的实施记录、**已确认的运行时约定**、踩过的坑与教训、待办清单 |
| [已有方案调研与选型对比](docs/research-existing-solutions.md) | 27 个同类产品/开源项目的横向对比、同类产品普遍失败点、自研缺口、对本项目的启示 |

## 一句话结论

开源生态里**不存在**「Windows 常驻秒级捕获 + AI 任务拆解 + 本地单一事实源」三合一方案，
因此自研核心（捕获 / 拆分 / 存储），外围借鉴 Backlog.md 式「Markdown 导出 + 可选 Git」作为数据出口。

## 未完成的部分

| 项 | 说明 |
| --- | --- |
| **搜索定位的其余类别** | 子任务 / 项目 / 进展 / 日志。前三者需要「展开祖先」机制（它们在折叠区里），应**一起做**而不是逐个打补丁 |
| **快捷键自定义**（F-05） | 需要按键捕获控件 + 冲突检测。当前热键是外壳里的常量，设置页只读显示 |
| **焦点候选范围做成设置项** | 当前口径固定；用户要求可选（今日 / 进行中 / 全部） |
| 清理存储（F-04c） | 转出后的收件箱条目会永久留在库里（用于回溯与撤销）但界面看不到，需要一条清理路径 |
| 每日复盘提醒 / 截止提醒（F-22/F-23） | 托盘的「暂停提醒」为它们预留，当前置灰 |
| AI 拆分、Markdown 导出（M2） | 契约已定，等配置 Provider 时再开 |
| **常驻内存** | 实测约 590MB（两个 WebView），高于需求 §8 的 500MB 上限。若成为问题，**该动的是架构**（例如共用一个 WebView），而不是砍功能 |

## 开发约定

- **不用 `Set-Content -Encoding utf8` 写文本文件** —— PowerShell 5 会带 BOM，
  而 JSON/HTML/`LICENSE` 带 BOM 会引发难以定位的解析问题
- 文本文件一律 UTF-8 无 BOM；换行由 `.gitattributes` 统一
- 内核测试：`node --test tests/`
- 自检：`node src/cli/wh.ts verify`

## 许可证

**GNU General Public License v3.0 or later** —— 见 [LICENSE](LICENSE)。

简单说：可以自由使用、修改、分发，**但衍生作品必须以同样的许可证开源**。
若你需要把它用在闭源或商业产品里，GPL 不允许 —— 可以找我谈谈另一种授权。
