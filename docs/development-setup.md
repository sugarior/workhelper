# 开发环境搭建

> **本文写给"要在另一台设备上继续开发"的人或 AI Agent。**
> 结构是"按需分级 + 可复制命令 + 可验证结果"，可以直接照着执行。
>
> 最后更新：随 `0.3.0`（M1 完成、已打安装包）。

---

## 0. 一分钟结论

| 想做的事 | 需要装什么 |
| --- | --- |
| **改内核、改界面、跑测试** | **只要 Node ≥ 22.6** |
| 改桌面外壳（托盘 / 热键 / 悬浮组件） | 再加 **Rust + MSVC C++ 生成工具** |
| 重新打包出安装器 | 再加 **tauri-cli**（本机实测编译约 38 分钟）|

**没有 `npm install` 这一步** —— `dependencies` 是空的，仓库里也没有 `node_modules`。

---

## 1. 最小可用（覆盖 90% 的开发）

### 1.1 前置条件

| 项 | 要求 | 为什么 |
| --- | --- | --- |
| **Node.js** | **≥ 22.6**（实测 v26.10.0） | ① 需要内置 **`node:sqlite`** —— 这是"零原生编译依赖"的前提<br>② 需要**原生运行 TypeScript**（类型剥离）—— 因此没有 `tsc`、没有构建步骤 |
| 操作系统 | Windows 10/11 | 桌面外壳依赖 Windows 注册表、WebView2、`reg.exe` |

**验证 Node 是否合格**（这一条不过，后面全部无法进行）：

```bash
node --version                                   # 应 ≥ v22.6

node -e "require('node:sqlite'); console.log('node:sqlite OK')"

# 验证能直接运行 TypeScript。用 .then 而不是顶层 await ——
# `node -e` 默认按 CommonJS 解析，顶层 await 会报错。
node -e "import('./src/core/db/connection.ts').then(m => console.log('TS OK, SCHEMA_VERSION =', m.SCHEMA_VERSION))"
```

三条都要成功。第二条失败说明 Node 版本太低（无 `node:sqlite`）；
第三条失败说明该 Node 不支持直接运行 TS（需 ≥ 22.6 的类型剥离）。

### 1.2 拿代码

```bash
git clone https://github.com/sugarior/workhelper.git
cd workhelper
```

### 1.3 验证环境（**先做这一步，再看代码**）

```bash
node --test tests/          # 应输出：tests 344 / pass 344 / fail 0
node src/cli/wh.ts verify   # 应输出：业务自检 : 通过，未发现矛盾数据
```

`verify` 会**自动建库并跑完全部 7 个迁移**（`SCHEMA_VERSION = 7`）。
所以这两条命令同时验证了：Node 版本、TS 支持、`node:sqlite`、迁移链、业务不变量。

### 1.4 跑起来

```bash
node src/ui/main.ts                    # 默认端口 7317、数据目录 <项目根>/data
# 打开 http://127.0.0.1:7317
```

服务**只监听 `127.0.0.1`**，不对局域网开放。

**想做隔离实验**（不碰真实数据）——CLI 与界面服务**都支持** `--data`：

```bash
node src/ui/main.ts --port 7399 --data D:/dev/wh-scratch
node src/cli/wh.ts --data D:/dev/wh-scratch status
```

界面服务的完整参数表：`node src/ui/main.ts --help`

---

## 2. 桌面外壳开发（改 Rust 那部分）

### 2.1 装 Rust

到 <https://rustup.rs> 装 `rustup`，它会一并引导安装 **MSVC C++ 生成工具**。
缺 MSVC 的典型报错是 `link.exe not found`。

```bash
rustc --version     # 实测可用：1.99.0
cargo --version
```

### 2.2 先补资源目录（**最容易漏的一步**）

`shell/src-tauri/resources/` **不在版本库里**（刻意的：它含约 100MB 的 `node.exe`，
且 `src/` 部分是仓库 `src/` 的副本）。但 `tauri.conf.json` 声明了它 ——
**不生成它，`cargo build` 会直接失败**。

```bash
node scripts/prepare-resources.mjs
```

它会：
1. 从系统 Node 复制 `node.exe` → `resources/node/`
2. 复制仓库 `src/` → `resources/src/`
3. 重建 `resources/.gitignore`（**必须**，否则那 100MB 会被 `git add -A` 提交，见 §5.1）
4. 自检随包 Node 能运行

看到 `完成。现在可以执行 cargo build / tauri build。` 才算成功
（若加了 `--src-only`，提示语是 `完成（仅 src）。`）。

### 2.3 编译与运行

```bash
cd shell/src-tauri
cargo run
```

首次编译较久（本机实测 release 约 9–14 分钟；`tauri-cli` 单独装约 38 分钟）。

**开发态会保留一个命令行窗口** —— 它是排查的主要依据（"内核已就绪，耗时 …" 这类日志
都从这里看）。发布态不显示它（`windows_subsystem = "windows"`）。

### 2.4 `target/` 放哪

仓库根的 `.cargo/config.toml` 把编译产物指到 D 盘：

```toml
target-dir = "D:/cargo-target/workhelper-shell"
```

**若目标设备没有 D 盘，改成存在的盘符，或删掉这一行**（代价：占 C 盘 2–4GB）。

> 位置必须在**仓库根**：`.cargo/config.toml` 是按**当前工作目录**向上查找的，
> 放在 `shell/` 下时，从仓库根调用 `cargo build --manifest-path ...` 读不到它。

---

## 3. 重新打包安装器

```bash
cargo install tauri-cli --version '^2' --locked    # 本机实测约 38 分钟
cd shell/src-tauri
cargo tauri build
```

产物：`<target-dir>/release/bundle/nsis/工作秘书_<版本>_x64-setup.exe`

**注意 `cargo tauri build` 不接受 `--manifest-path`** —— 必须在 `shell/src-tauri` 下调用。

`build.rs` 会在每次编译前自动跑 `prepare-resources.mjs --src-only`
（只同步约 400KB 的源码树，跳过 100MB 的 `node.exe`，实测 303ms），
**保证打包态内核与仓库一致**。

---

## 4. 网络：GitHub 连不上怎么办

**git 不读 Windows 的系统代理设置** —— 它只认环境变量或自己的 `http.proxy`。
只开代理软件不够，必须显式告诉 git（端口按本机代理改）：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:7897
```

用 `http.<url>.proxy` 这种**按域名限定**的写法，其它远程（公司 GitLab、Gitee 等）不受影响。

验证：

```bash
git ls-remote --heads origin      # 应 1–2 秒返回，而不是 21 秒后失败
```

撤销：

```bash
git config --global --unset http.https://github.com.proxy
```

> **症状对照**：`Failed to connect to github.com port 443 after 21097 ms`
> = 走了直连且被中断。而代理配错会是另一种报错（`Could not resolve proxy`）。

---

## 5. 必须知道的坑

### 5.1 `resources/` 那 100MB 绝不能提交

`resources/` 里含系统 Node 的副本（约 100MB）与仓库 `src/` 的副本。**它曾经被误提交过一次**：
仓库从 0.7MB 涨到 44.6MB，后来靠重写历史才清掉。

根因：`prepare-resources.mjs` 会**先整体删掉 `resources/` 目录再重建**，
而该目录里有一个被跟踪的 `.gitignore` —— 删掉后忽略规则随之消失，
下一次 `git add -A` 就把整个目录当成新增文件。

**现状已双保险**：脚本每次主动重写 `resources/.gitignore`。

**提交前自检**（这条应该成为习惯）：

```bash
git status --short            # 不该出现 shell/src-tauri/resources/ 下的任何文件
git ls-files | grep -c resources   # 应只有 2 个：prepare-resources.mjs 与 .gitignore
```

### 5.2 文本文件一律 UTF-8 **无 BOM**

**不要用 PowerShell 5 的 `Set-Content -Encoding utf8`** —— 它会加 BOM。
JSON / HTML / `LICENSE` 带 BOM 会引发难以定位的问题：

| 受害者 | 症状 |
| --- | --- |
| `index.html` / `capture.html` | 页面行为异常，难以定位 |
| `tauri.conf.json` | 构建时报 JSON 解析错误 |
| 外壳读 `config.json` | 解析失败、退回默认值（表现为"设置不生效"）|
| `LICENSE` | GitHub 认不出许可证类型 |

**改用**：`[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))`，
或直接用 Node 的 `writeFileSync`（默认无 BOM）。

### 5.3 前端改动在 dev 与 release 里生效方式不同

| 部分 | `cargo build`（dev） | `cargo build --release` |
| --- | --- | --- |
| 前端（`src/ui/static`） | **运行时从仓库读** —— 改了立刻生效 | **构建时固化进二进制** —— 改了必须重编 |
| 内核（`src/`） | 从仓库读 | 从 `resources/src` 读 |

**"我改了前端却没生效"时，先怀疑自己在看哪一份，而不是浏览器缓存。**
核对方法（在页面里执行）：

```js
const t = await (await fetch(location.origin + '/views.js')).text();
t.includes('你刚写的标识符');   // false 说明加载的不是你以为的那份
```

### 5.4 数据目录与你的数据

| 形态 | 默认数据目录 |
| --- | --- |
| 开发态 | `<项目根>/data` |
| 安装后 | `%APPDATA%\WorkHelper\data` |

可在 `%APPDATA%\WorkHelper\config.json` 里用 `dataDir` 覆盖（**改后需重启**）。

**克隆仓库不会带走数据** —— `data/`、`*.db` 都在 `.gitignore` 里（那是刻意的：
私人工作数据不该进公开仓库）。所以**新设备上是一个空库**，这是正常的。

要把数据迁过去：用 `node src/cli/wh.ts backup`，或**先退出程序**再拷 `data/workhelper.db`
（程序在跑时拷会拿到不完整的库，因为 WAL 里的改动还没合并）。

**发布态的排查线索**在 `<数据目录>\workhelper.log`（发布版没有控制台，
内核的启动信息与错误都写在这里）。

---

## 6. 项目约定（改代码前先读这一节）

### 6.1 分层纪律

```
core/domain  →  core/db  →  core/repo  →  core/service  →  ui / cli
```

| 规则 | 说明 |
| --- | --- |
| **SQL 只出现在 `db/` 与 `repo/`** | 其它层一行 SQL 都不该有 |
| **界面不碰仓储** | 只走 `core/service` 的服务门面 |
| `src/ui/main.ts` | 组合根：唯一把各层拼起来的地方 |
| 业务判断不放界面 | 能否流转、是否阻塞、汇总口径都在内核里 |

**新增设置项时的归属**：数据语义（跟着数据备份走）→ 内核 `settings` 表；
这台机器的窗口/OS 状态 → 外壳 `config.json`。设置页分别取、合并显示。

### 6.2 内核服务新增方法时要同步的地方

`src/ui/server.ts` 里有一张**方法白名单**。新增服务方法若要让界面能调，
必须同时改两处，否则界面报"服务 X 没有方法 Y"或"不允许调用方法 Y"：

1. `core/service/<x>Service.ts` —— **必须是服务门面的顶层方法**
   （埋在子对象里如 `settings.setDayBoundaryHour` 界面调不到，
   因为 HTTP 派发按名字调顶层）
2. `src/ui/server.ts` 的 `ALLOWED` 白名单

### 6.3 验证纪律（本项目的硬要求）

| 做法 | 说明 |
| --- | --- |
| **先量再改** | 优先读 DOM/几何、直接查库、抓日志，而不是推断。本项目多次因为"看着对"而误判 |
| **判据要能区分** | 例如判断"页面是否加载"不能用窗口标题（外壳设的标题与 `<title>` 恰好相同，区分不出任何东西）；改用"内核是否收到 API 请求" |
| **失败必须出声** | "点了没反应"是本项目反复出现的、最难排查的形态。任何静默失败都要改成明确提示 |
| **清理测试数据按精确标识** | 不要按时间或模式批量删（本项目误删过用户数据）|

### 6.4 每次改完跑这些

```bash
node --test tests/            # 内核测试（改内核必跑）
node src/cli/wh.ts verify     # 业务自检（改数据层必跑）
node --check <改过的 .js>     # 前端模块语法（无构建步骤，因此没有编译器兜底）
cd shell/src-tauri && cargo build   # 改 Rust 必跑
```

---

## 7. 给 AI Agent 的执行清单

> 若你是被要求"在这台设备上继续开发 WorkHelper"的 Agent，按顺序执行：

**第一步：确认能不能开发（不要跳过）**

```bash
node --version                       # < 22.6 就停下来告诉用户
node --test tests/                   # 必须 344 pass
node src/cli/wh.ts verify            # 必须"通过"
```

**第二步：读设计文档建立上下文（按这个顺序）**

| 顺序 | 文件 | 读它为了知道 |
| --- | --- | --- |
| 1 | `README.md` | 这是什么、有哪些功能、未完成什么 |
| 2 | `docs/design.md` | 分层纪律、DDL、服务接口、**已记录的缺陷与教训** |
| 3 | `docs/requirements.md` | 功能需求编号（F-xx）、交互契约、验收口径 |
| 4 | `docs/plan-next-steps.md` | 落地顺序、**已确认的运行时约定**、待办清单 |
| 5 | 本文件 | 环境与坑 |

**第三步：动手前**

- 确认要做的功能在需求里的编号，并读它的**约束列**（那里常写着"为什么不能那样做"）
- 若改动触及数据层，先想清楚"这个不变量能不能下沉到 SQL" —— 能就别写在服务层
- 若改动有界面部分，**先让用户体验再继续**（用户明确要求过）

**第四步：改完**

- 跑 §6.4 的全部命令
- 提交信息用中文、说明"为什么"而不只是"做了什么"
- 若发现文档与实际不符，**改文档**（本项目的文档是资产，不是装饰）

---

## 8. 环境自检速查表

| 检查项 | 命令 | 期望 |
| --- | --- | --- |
| Node 版本 | `node --version` | ≥ v22.6 |
| `node:sqlite` | `node -e "require('node:sqlite')"` | 无输出（成功）|
| TS 直跑 | `node src/cli/wh.ts status` | 打印状态 |
| 内核测试 | `node --test tests/` | 344 pass |
| 业务自检 | `node src/cli/wh.ts verify` | 通过 |
| 界面服务 | `node src/ui/main.ts` | 打印"界面服务已启动" |
| Rust | `rustc --version` | 有版本号（仅外壳开发需要）|
| 资源就绪 | 见下方两条 | 两个都应**存在** |
| GitHub 连通 | `git ls-remote --heads origin` | 1–2 秒返回 |

**资源目录怎么判断**（新克隆后 `resources/` **目录是存在的**，容易误判成"已就绪"）：

| 路径 | 新克隆后 | 跑完 §2.2 后 |
| --- | --- | --- |
| `resources/node/node.exe` | **缺失** | 存在（约 100MB）|
| `resources/src/ui/main.ts` | **缺失** | 存在 |

**判据是这两条，而不是"`resources/` 目录在不在"** ——
目录在任何时候都在（它含一个被跟踪的 `.gitignore`），
只看目录会把"还没生成"误判成"已就绪"，然后 `cargo build` 才报错。
