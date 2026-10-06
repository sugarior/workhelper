//! 工作秘书的桌面外壳（实验 B2-a）。
//!
//! 这一版**只做一件事**：验证 Tauri 能否可靠地
//!   1. 找到 node 可执行文件
//!   2. 拉起 `src/ui/main.ts` 这个已有的 Node 服务
//!   3. 等它就绪后把窗口指过去（加载的正是你现在浏览器里用的那套界面）
//!   4. 退出时**干净地收掉整棵进程树**（不留僵尸 node）
//!
//! 刻意不在这版做全局热键与托盘 —— 那是 B2-b / B2-c 的事。
//! 一次只验一件事，失败时才知道是哪一环。
//!
//! 架构决策（plan §B1-a）：外壳**不碰数据层**，内核一行不改，
//! 界面仍走 HTTP。所以这个文件里没有任何 SQL、没有任何业务规则。

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// `Manager` 提供 `AppHandle::state()` —— 少了它编译不过，
// 而编译器的提示很明确（"trait Manager which provides state is implemented but not in scope"）
use tauri::{Manager, RunEvent, WindowEvent};

/// 内核服务端口。与 `src/ui/main.ts` 的默认值一致；这里显式传入，避免两边默认值漂移。
const PORT: u16 = 7317;

/// 启动超时。冷启动实测目标 ≤ 2s（需求 §8），但首次拉起要留足余量。
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// 被托管的 Node 子进程。放在 Mutex 里是为了在退出事件中取出并清理。
struct NodeServer(Mutex<Option<Child>>);

/// 定位仓库根。
///
/// **首选编译时注入的路径**（见 build.rs 的说明）：`target-dir` 被指到 D 盘后，
/// 可执行文件位于 `D:\cargo-target\...\debug\`，从它向上**永远找不到**仓库根 ——
/// 这两个决定各自都对，组合起来就错了。编译时注入不受产物位置影响。
///
/// 仍保留"向上查找"作为兜底：万一有人把二进制拷进项目内运行，那条路才走得通。
fn find_repo_root() -> Result<PathBuf, String> {
    if let Some(injected) = option_env!("WORKHELPER_REPO_ROOT") {
        let path = PathBuf::from(injected);
        if path.join("src").join("ui").join("main.ts").is_file() {
            return Ok(path);
        }
    }

    let exe = std::env::current_exe().map_err(|e| format!("取不到自身路径：{e}"))?;
    let mut dir = exe.parent();
    while let Some(current) = dir {
        if current.join("src").join("ui").join("main.ts").is_file() {
            return Ok(current.to_path_buf());
        }
        dir = current.parent();
    }
    Err(format!(
        "找不到仓库根：编译时注入的路径与从 {} 上溯都失败",
        exe.display()
    ))
}

/// 找 node 可执行文件。
///
/// **优先随包 Node，其次系统 Node** —— 顺序不能反：
/// 若先查系统，那么"打包时漏掉 Node"就**测不出来**（它会静默用系统的跑起来）。
/// 见 plan §4.1.1「让依赖无法隐藏」。
///
/// 开发态没有随包 Node（由 `scripts/prepare-resources.mjs` 在打包前生成），
/// 因此会落到系统查找分支 —— 这是有意的：开发时改了内核无需重新准备资源。
fn find_node(resources_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(dir) = resources_dir {
        let bundled = dir.join("node").join("node.exe");
        if bundled.is_file() {
            return Ok(bundled);
        }
        // 打包态却没有随包 Node —— 这是安装损坏，必须明确报错而不是回退到系统。
        // 静默回退会掩盖打包缺陷，那正是 §4.1.1 要防的。
        return Err(format!(
            "打包形态下找不到随包的 Node：期望 {} 存在。安装可能不完整，建议重新安装。",
            bundled.display()
        ));
    }

    if let Ok(path) = which::which("node") {
        return Ok(path);
    }
    let candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        r"D:\AppGallery\node.exe",
    ];
    for candidate in candidates {
        let path = Path::new(candidate);
        if path.is_file() {
            return Ok(path.to_path_buf());
        }
    }
    Err("找不到 node.exe：既没有随包 Node，系统 PATH 与常见安装位置也没有".to_string())
}

/// 端口是否已被占用（本次实验据此判断该不该由自己拉起内核）。
fn port_in_use() -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{PORT}").parse().expect("端口常量应合法"),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// 轮询端口直到服务就绪，返回耗时。
fn wait_until_ready(started: Instant) -> Result<Duration, String> {
    while started.elapsed() < READY_TIMEOUT {
        if port_in_use() {
            return Ok(started.elapsed());
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    Err(format!(
        "等待内核服务就绪超时（{}s）—— node 可能启动失败，见上方日志",
        READY_TIMEOUT.as_secs()
    ))
}

/// 拉起内核服务，返回子进程。
fn spawn_kernel(paths: &RuntimePaths) -> Result<Child, String> {
    let node = find_node(paths.resources_dir.as_deref())?;
    let entry = paths.kernel_root.join("src").join("ui").join("main.ts");
    if !entry.is_file() {
        return Err(format!("内核入口不存在：{}", entry.display()));
    }

    println!("[shell] node      = {}", node.display());
    println!("[shell] 内核入口  = {}", entry.display());

    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .arg("--port")
        .arg(PORT.to_string())
        // 数据目录由外壳显式传入（B3-2）。
        // **不能靠内核自己推导**：打包后内核在 <安装目录>\resources\src\ 下，
        // 它推导出的默认目录会落在 Program Files 里 —— 那里不可写。
        // 外壳还负责解析用户的覆盖配置，并把目录**实际可写**验证过（见 resolve_runtime_paths）。
        .arg("--data")
        .arg(&paths.data_dir)
        // 把自身 PID 交给内核：外壳被强杀时（崩溃、任务管理器结束），
        // 外壳自己的退出处理不会执行，内核必须能自己发现宿主没了。
        // Windows 没有"父进程死了子进程跟着死"的默认行为 —— B2-a 实测确认过。
        .arg("--parent-pid")
        .arg(std::process::id().to_string())
        // 工作目录设为内核根：内核按脚本位置推导它自己的相对基准，
        // 保持一致可以避免"两份不同的相对路径"这类困惑
        .current_dir(&paths.kernel_root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null());

    // 请求日志开关：设 WORKHELPER_VERBOSE=1 启动外壳即可看到每个 API 请求。
    // 排查"界面到底有没有连上内核"这类问题时，这是最直接的证据 ——
    // 窗口标题、界面外观都区分不出"页面加载了"与"数据取到了"。
    if std::env::var("WORKHELPER_VERBOSE").is_ok_and(|value| value == "1") {
        command.arg("--verbose");
        println!("[shell] 已开启内核请求日志（WORKHELPER_VERBOSE=1）");
    }

    let child = command
        .spawn()
        .map_err(|e| format!("启动 node 失败：{e}"))?;

    println!("[shell] 内核已启动，PID = {}", child.id());
    Ok(child)
}

/// 收掉整棵进程树。
///
/// **必须用 taskkill /T**：Node 服务自己可能还有子进程，
/// 直接 kill 父进程会留下孤儿。而且 Windows 没有"随父进程退出"的默认行为。
fn kill_tree(child: &mut Child) {
    let pid = child.id();
    println!("[shell] 正在收掉内核进程树（PID {pid}）…");

    // 先尝试温和退出，给它机会关闭 SQLite 连接
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }

    // 回收 zombie（Windows 上无实际影响，但保持跨平台正确）
    let _ = child.wait();
    println!("[shell] 内核已退出");
}

/// 快记浮窗的全局热键。用户确认要 `Ctrl+Alt+Space`。
///
/// 用字符串解析而不是构造 `Modifiers`/`Code`：解析失败时错误信息里带着原始
/// 字符串，排查"哪个键没被识别"更容易；而且以后要做成可配置的，
/// 存字符串直接就能用。
const HOTKEY_CAPTURE: &str = "ctrl+alt+Space";

/// 「记一笔」的全局热键（需求 F-15c）。
///
/// **与快记的区别**：快记是"开个小窗、记一条到收件箱"；
/// 记一笔是"记到**当前焦点任务**的时间线上"，因此不需要开窗 ——
/// 它把主窗口带到前面，并把焦点放进顶部常驻条的输入框。
///
/// 需求 F-15c 说"顶部常驻条也提供同一入口（同一个动作的两个位置，不是两套功能）"，
/// 因此这里**复用**焦点条那套 UI（类型选择 + 输入框），不另做一个小窗 ——
/// 另做一套就意味着两处都要维护"记到哪、有哪些类型"。
const HOTKEY_NOTE: &str = "ctrl+shift+Space";

/// 快记窗的标签。用它判断窗口是否已存在（复用而不是每次新建）。
const CAPTURE_LABEL: &str = "capture";

/// 注入脚本：把网页里的 `window.close()` 接到"隐藏窗口"上。
///
/// **为什么需要它**：`capture.js` 保存成功后调用 `window.close()` —— 那在浏览器里是对的
/// （它的注释也写着"只有由脚本打开的窗口才允许被脚本关闭"），
/// **但 Tauri 的 WebView 不认这条**：窗口不是 `window.open()` 开的，于是它是空操作。
///
/// 后果很难查：`closeWindow()` 已经先加了 `.closing`（透明度动画、`forwards` 保持），
/// 窗口永远停在"透明"状态 —— 用户看到的是**黑屏**（空窗口的默认底色）。
///
/// **为什么现在这条路能成**：注入要求 `__TAURI_INTERNALS__` 可用，而它只在
/// **应用协议**的页面上被注入。此前快记窗用 `WebviewUrl::External`（http 外部地址），
/// 实测 eval 调用返回 Ok 但实际不执行、回调不触发 —— 试过三种方案全部静默失败。
/// B3-4 把快记窗改走 `WebviewUrl::App`，与主窗口同一条加载路径
/// （主窗口的 JS 通道一直是正常的，这是选择这条路线的依据）。
///
/// 用 `hide()` 而不是 `close()`：窗口留着，下次热键唤出只需 `show()`，
/// 不必再付一次 WebView2 初始化（创建 380ms → 复用 55ms）。
const CLOSE_SHIM: &str = r#"
(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return;
  const invoke = internals.invoke.bind(internals);
  window.close = () => { invoke('hide_capture_window').catch(() => {}); };
})();
"#;

/// 隐藏快记窗（由页面里的 `window.close()` 替身调用）。
#[tauri::command]
fn hide_capture_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// 页面调用：打开快记窗（主界面「＋ 快记」按钮）。
///
/// **为什么需要这个命令**：那个按钮原来用 `window.open('/capture', ...)` ——
/// 在浏览器里能用，**在 Tauri 的 WebView 里被拦截**（Tauri 默认不允许网页开新窗口），
/// 于是表现成"点了没反应"。这正是第 1 类错误的形态：
/// 同一件事在两种环境下走了两条不同的路，其中一条在外壳里根本不通。
///
/// 改为调这个命令，与热键**走同一个 `open_capture_window`** ——
/// 于是"按钮"与"热键"是同一个动作的两个位置，不是两套实现（需求 F-01/F-05）。
#[tauri::command]
fn open_capture_window_command(app: tauri::AppHandle) {
    open_capture_window(&app);
}

/// 打开快记窗：不存在就建（走应用协议 + 注入关闭替身），存在就显示并**重载页面**。
///
/// **必须走应用协议**（`WebviewUrl::App`）而不是外部 http 地址 ——
/// 后者没有 Tauri 的 JS 通道，`window.close` 替身注入不进去（见 `CLOSE_SHIM` 的说明）。
///
/// **每次唤出都重载页面** —— 修的是一个真实缺陷：
/// 窗口只是 `hide()`（为了复用、省掉 380ms 的 WebView2 初始化），页面**没有销毁**，
/// 于是两处状态残留下来：
///   · `.closing` 类（`opacity: 0` + 动画 `forwards` 保持）→ 再唤出时**看得见框、看不见内容**
///   · `capture.js` 的模块级 `finished = true` → 保存逻辑开头就是 `if (finished) return`，
///     于是**再也不能写入**（用户实测报告："保存一次后再次呼出不能写入了"）
///
/// 重载把这两处（以及将来任何新增的模块级状态）一次性归零，
/// **不需要往界面代码里加"重置钩子"** —— 那种钩子会随功能增加而必然漏掉几处。
fn open_capture_window(app: &tauri::AppHandle) {
    let began = Instant::now();

    if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        // 重载会让页面重新走一遍加载流程（含 initialization_script），
        // 因此 `window.close` 替身也是新的，不必手动补。
        if let Err(error) = window.eval("location.reload()") {
            // eval 失败不该让窗口不出现：最坏情况回到"状态残留"的旧行为，
            // 但必须说出来 —— 静默失败正是这个缺陷最初难查的原因。
            eprintln!("[shell] 快记窗重载失败（将沿用上一轮状态）：{error}");
        }
        println!("[shell] 快记窗唤出并重载，耗时 {} ms", began.elapsed().as_millis());
        return;
    }

    // `capture.html` 由应用协议从 frontendDist 根提供。
    // 页面里的 `/app.css`、`/capture.js` 是绝对路径，而应用协议会跳过开头的 `/`
    // （tauri/src/protocol/asset.rs 里明确 `// skip leading /`），因此能正确解析 ——
    // 同一套 HTML 在 HTTP 下（浏览器开发）与这里都能用，不需要两套路径写法。
    let built = tauri::WebviewWindowBuilder::new(
        app,
        CAPTURE_LABEL,
        tauri::WebviewUrl::App("capture.html".into()),
    )
    .title("快记")
    .inner_size(680.0, 330.0)
    // 浮窗形态（需求 §6.1）：无边框、置顶、不进任务栏
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .center()
    .skip_taskbar(true)
    // 窗口底色跟随界面，避免加载瞬间闪一下系统默认的黑/灰
    .background_color(tauri::window::Color(245, 246, 248, 255))
    // 关键：在页面脚本之前把 window.close 换掉。
    // 必须早于 `capture.js` 执行，否则它可能已经取得原生引用。
    .initialization_script(CLOSE_SHIM)
    .build();

    match built {
        Ok(window) => {
            let _ = window.set_focus();
            println!("[shell] 快记窗首次创建，耗时 {} ms", began.elapsed().as_millis());
        }
        Err(error) => eprintln!("[shell] ✗ 创建快记窗失败：{error}"),
    }
}
/// 全局热键「记一笔」（需求 F-15c + §4.8）。
///
/// **改为唤出悬浮组件的输入态**，不再把主窗口带到前面。
/// 原因是主窗口迟早要常驻托盘，届时"记一笔却要先打开整个软件"就很别扭 ——
/// 而记一笔的本意是"不离开当前工作就能记一句"。
///
/// **为什么用"标记 + 页面轮询"而不是事件**：
/// 页面侧唯一被实测证明可靠的能力是 `invoke`（命令调用）；事件插件在
/// `__TAURI_INTERNALS__` 上的调用形态没有验证过，而本项目已经因为"没验证就下手"
/// 在快记窗上耗过很久。标记 + 轮询只用到 `invoke` 这一条路，行为可预期。
/// 轮询每 150ms 一次本地命令调用，代价可以忽略。
fn request_note_input(app: &tauri::AppHandle) {
    focus_widget_input(app);
}

/// 外壳发给悬浮组件的指令。
///
/// **为什么是一个枚举而不是几个 `AtomicBool`**：本项目已经栽过"同一类东西
/// 用两种机制传"的跟头（快记窗那三个静默失败的方案）。一个通道传所有指令，
/// 将来加指令只需加一个枚举值，不会出现两个标志互相打架、或页面漏读其中一个。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WidgetCommand {
    /// 进入「记一笔」输入态（热键或展开按钮触发）
    EnterInput,
    /// 只重画数据，不动形态（焦点变了、数据变了）
    Refresh,
    /// 当前没有焦点任务，请页面弹出"选一个焦点"
    PickFocus,
}

impl WidgetCommand {
    /// 转成数字给页面。页面侧只认这几个数 —— 两边靠**同一张表**对照，
    /// 因此这里和 widget.js 里的常量必须一起改（注释已互相指明）。
    fn code(self) -> u8 {
        match self {
            WidgetCommand::EnterInput => 1,
            WidgetCommand::Refresh => 2,
            WidgetCommand::PickFocus => 3,
        }
    }
}

/// 「等着悬浮组件来取」的指令槽。
///
/// **取值即清零**（`swap`）—— 这样一次指令只生效一次；
/// 若只读不清，页面每次轮询都会重复执行（例如反复把焦点抢进输入框）。
struct WidgetCommandSlot(std::sync::atomic::AtomicU8);

impl WidgetCommandSlot {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicU8::new(0))
    }

    fn put(&self, command: WidgetCommand) {
        self.0.store(command.code(), std::sync::atomic::Ordering::SeqCst);
    }

    fn take(&self) -> u8 {
        self.0.swap(0, std::sync::atomic::Ordering::SeqCst)
    }
}

/// 页面调用：取走一条待执行的指令；0 表示没有。
#[tauri::command]
fn take_widget_command(state: tauri::State<'_, WidgetCommandSlot>) -> u8 {
    state.take()
}

/// 主界面调用：数据变了，请悬浮组件重画（焦点切换、取消聚焦、记完一笔等）。
///
/// **为什么由主界面主动通知**：悬浮组件只在加载时刷新一次，之后不会自己知道
/// 外面发生了什么。而"主界面切了焦点、组件还显示旧任务"是必然会遇到的。
///
/// 用"外壳转发"而不是让两个窗口直接通信：外壳本来就是唯一知道所有窗口的东西，
/// 让页面之间互相找对方会引入"谁先启动"这类时序问题。
#[tauri::command]
fn notify_widget_refresh(app: tauri::AppHandle) {
    if let Some(slot) = app.try_state::<WidgetCommandSlot>() {
        slot.put(WidgetCommand::Refresh);
    }
}

/// 页面调用：告诉外壳「记一笔」有没有落点（有没有焦点任务）。
///
/// **只有页面知道这件事**（`focusNoteInput()` 的返回值），外壳判断不了。
/// 没有焦点任务时用户的本意是"记一笔"而系统做不了 —— 必须说出来，
/// 否则用户只会觉得"按了没反应"（需求 F-05 明确要避免的形态）。
#[tauri::command]
fn report_note_result(accepted: bool) {
    if accepted {
        println!("[shell] 记一笔：输入框已就位");
    } else {
        println!("[shell] 记一笔：没有焦点任务，已提示用户先选一个");
    }
}

/// 悬浮小组件的窗口标签。
const WIDGET_LABEL: &str = "widget";

/// 应用名，用于 `%APPDATA%` 下的目录名与配置文件位置。
const APP_DIR_NAME: &str = "WorkHelper";

/// 页面调用：收起悬浮组件的输入态（Esc 或点 ✕）。
///
/// 只收起输入态、**不隐藏窗口** —— 组件是常驻的（F-17）。
/// "从托盘隐藏"是另一件事，见 `set_widget_visible`。
#[tauri::command]
fn collapse_widget(app: tauri::AppHandle) {
    if let Some(mode) = app.try_state::<WidgetMode>() {
        mode.set(false);
    }
}

/// 页面调用：把悬浮窗当前坐标存进配置。
///
/// 平时由外壳在窗口移动后自动落盘（见 `app.run` 里的 `Moved` 分支），
/// 这个命令留给"想立刻保存"的场合（目前页面不调它，但保留作为兜底入口）。
#[tauri::command]
fn save_widget_position(app: tauri::AppHandle) {
    persist_widget_position(&app);
}

/// 把悬浮窗当前坐标写进配置。移动节流后由定时器调用。
fn persist_widget_position(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let mut config = state.config.lock().expect("锁被污染");
    if config.widget_pos == Some((position.x, position.y)) {
        return;
    }
    config.widget_pos = Some((position.x, position.y));
    config.save(&state.config_root);
}

/// "窗口动过、位置还没落盘"的标记。
///
/// **为什么要节流**：拖动时 `Moved` 每秒触发几十次，
/// 每次都写配置文件既无意义又伤盘。置个标记，由后台定时器统一落盘。
struct WidgetMoveSaver(std::sync::atomic::AtomicBool);

/// 显示或隐藏悬浮组件，并把选择记进配置（托盘菜单用）。
///
/// **隐藏只是不常驻显示**：热键仍然能唤出输入态（用户确认过）——
/// 否则用户藏起组件后就再也找不到记一笔的入口。
fn set_widget_visible(app: &tauri::AppHandle, visible: bool) {
    use tauri::Manager;

    if let Some(state) = app.try_state::<ShellState>() {
        let mut config = state.config.lock().expect("锁被污染");
        config.widget_visible = visible;
        config.save(&state.config_root);
    }

    let window = match app.get_webview_window(WIDGET_LABEL) {
        Some(window) => window,
        None => {
            // 隐藏状态下窗口可能还没建过；只有要显示时才值得建
            if !visible {
                return;
            }
            match create_widget_window(app) {
                Ok(window) => window,
                Err(message) => {
                    eprintln!("[shell] ✗ {message}");
                    return;
                }
            }
        }
    };

    if visible {
        let _ = window.show();
        println!("[shell] 悬浮组件：显示");
    } else {
        let _ = window.hide();
        println!("[shell] 悬浮组件：隐藏（热键仍可唤出输入态）");
    }
}

/// 悬浮窗尺寸。
///
/// **固定不随形态变化**：idle（细栏）、input（展开）、pick（选焦点）三种形态
/// 用同一个窗口尺寸，切换只改 CSS 类，**不改窗口尺寸** ——
/// 后者要走外壳，对高频动作太慢，而且每次都要重算位置（放大时该往哪边扩？）。
///
/// 代价是 idle 时窗口下方有一大片透明区域。因为根元素透明、且那条细栏在最上方，
/// 视觉上就是"只有一条细栏"，代价只是那一片区域不响应桌面点击。
/// 取 260 高是为了让「选焦点」最多显示 5 项而不滚动（`WIDGET_PICK_MAX`）。
const WIDGET_W: f64 = 360.0;
const WIDGET_H: f64 = 260.0;

/// 距屏幕边缘的默认留白（首次运行、尚未拖过时把组件放在右下角）。
const WIDGET_MARGIN: f64 = 24.0;

/// 悬浮窗是否处于「记一笔」输入态。
///
/// 外壳需要知道它，因为"窗口失焦"要分情况处理：
/// 输入态失焦 → 收起回 idle；idle 失焦 → 什么都不做（组件本来就不该抢焦点）。
struct WidgetMode(std::sync::atomic::AtomicBool);

impl WidgetMode {
    fn is_input(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn set(&self, input: bool) {
        self.0.store(input, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 外壳运行时路径与配置（`Arc` 共享：窗口事件回调里也要能改配置并保存）。
struct ShellState {
    config: std::sync::Mutex<ShellConfig>,
    config_root: PathBuf,
}

/// 创建悬浮小组件窗（需求 F-17）。
///
/// **默认常驻显示**（用户确认），位置取上次拖动保存的坐标；
/// 首次运行放在屏幕右下角。
///
/// 关键窗口属性：
///   · `decorations(false)` —— 便签形态，没有标题栏
///   · `always_on_top(true)` —— 需求要求"置顶显示"
///   · `skip_taskbar(true)` —— 不该在任务栏占一格（那是主窗口的位置）
///   · `transparent(true)` —— 圆角之外要真的是桌面，而不是一块窗口底色
///   · `focused(false)` —— **绝不主动抢焦点**（F-17 的硬要求）
fn create_widget_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let (opacity, saved_pos, visible) = {
        let state = app.state::<ShellState>();
        let config = state.config.lock().expect("锁被污染");
        (config.widget_opacity, config.widget_pos, config.widget_visible)
    };

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        WIDGET_LABEL,
        // 不透明度通过 **URL 参数**交给页面，由 CSS 变量生效。
        //
        // **为什么不用窗口级的 `set_opacity`**：Tauri 2 的 `WebviewWindow`
        // 没有这个方法（窗口整体透明度依赖分层窗口，跨平台不可用，实测确认）。
        // 而组件的背景本来就是半透明的（`rgba(...)` + 背景模糊），
        // 用 CSS 变量调它反而更自然：**只影响面板本身，不影响里面的文字**——
        // 窗口级透明度会把文字一起变淡，小字会糊得看不清。
        tauri::WebviewUrl::App(format!("widget.html?opacity={opacity}").into()),
    )
    .title("悬浮组件")
    .inner_size(WIDGET_W, WIDGET_H)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    // 不抢焦点：组件是背景，用户没点它就不该拿走谁的焦点
    .focused(false)
    .visible(false); // 先建好再定位，避免在默认位置闪一下

    // 有保存过的位置就用它，否则右下角
    if let Some((x, y)) = saved_pos {
        builder = builder.position(x as f64, y as f64);
    } else if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        builder = builder.position(
            logical_w - WIDGET_W - WIDGET_MARGIN,
            logical_h - WIDGET_H - WIDGET_MARGIN - 48.0, // 再抬一点，避开任务栏
        );
    }

    let window = builder.build().map_err(|e| format!("创建悬浮组件失败：{e}"))?;
    if visible {
        let _ = window.show();
    }
    Ok(window)
}

/// 让悬浮组件响应「记一笔」热键并获取焦点。
///
/// **只有用户按下热键才会走到这里** —— 组件自己从不主动抢焦点（F-17）。
/// 因此这里（以及调用方）的 `set_focus` 是"响应用户意图"，不是"抢"。
///
/// **发的是 `EnterInput` 而不是"输入态"这个最终形态**：
/// 有没有焦点任务只有页面知道，因此由页面决定
/// "进输入态"还是"先弹出选焦点"（见 widget.js）。
/// 外壳不替它判断 —— 那会变成同一件事在两处各判一次。
fn focus_widget_input(app: &tauri::AppHandle) {
    let window = match app.get_webview_window(WIDGET_LABEL) {
        Some(window) => window,
        None => match create_widget_window(app) {
            Ok(window) => window,
            Err(message) => {
                eprintln!("[shell] ✗ {message}");
                return;
            }
        },
    };

    if let Some(slot) = app.try_state::<WidgetCommandSlot>() {
        slot.put(WidgetCommand::EnterInput);
    } else {
        eprintln!("[shell] ✗ 记一笔：指令槽未注册（内部错误）");
    }

    // 隐藏状态下也要能唤出（用户确认）：否则藏起来后记一笔就没入口了
    let _ = window.show();
    // `focused(false)` 建出来的窗口不会自己抢焦点，这里显式给 —— 用户按了热键
    let _ = window.set_focus();
}

/// 内存中的运行时路径解析结果。
struct RuntimePaths {
    /// 内核源码树所在目录（含 `src/ui/main.ts` 的那一级）
    kernel_root: PathBuf,
    /// 资源目录。**仅打包态有值** —— 它同时是"该不该用随包 Node"的判据
    resources_dir: Option<PathBuf>,
    /// 数据目录（已确保存在且可写）
    data_dir: PathBuf,
    /// 开发态还是打包态
    dev: bool,
    /// 配置文件所在目录（`%APPDATA%\WorkHelper`）。保存悬浮组件状态时要用
    config_root: PathBuf,
    /// 读到的外壳配置。`main` 会把它交给 Tauri 状态，之后由 `ShellState` 持有
    config: ShellConfig,
}

/// 判断是开发态还是打包态。
///
/// **判据：可执行文件旁边的 `resources/src/ui/main.ts` 是否存在。**
///
/// 这是**唯一与构建机无关**的判据。踩过的坑：
///   1. 从可执行文件向上找 `shell/src-tauri/Cargo.toml` —— 失败，
///      因为 `target-dir` 在 `D:/cargo-target/`，与仓库根没有共同祖先
///   2. 用"编译时注入的仓库根是否存在" —— 也失败，而且**更隐蔽**：
///      打包产物是在开发机上构建的，那个路径在构建机上**当然存在**，
///      于是打包版永远被判成开发态、永远用系统 Node。
///      在开发机上永远测不出来，装到别人机器上才炸。
///
/// 资源目录是安装布局独有的，与环境变量、构建路径、当前目录都无关。
///
/// **判错方向**：把打包态误判成开发态会导致用系统 Node（在别人机器上直接失败）；
/// 把开发态误判成打包态会导致找不到资源而报错。两者都吵，但前者更晚暴露 ——
/// 所以判据宁可偏向"看资源目录存不存在"这个客观事实。
fn detect_dev_mode() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return true; // 取不到自身路径只可能是异常环境，按开发态处理以便暴露问题
    };
    let Some(dir) = exe.parent() else { return true };
    !dir.join("resources").join("src").join("ui").join("main.ts").is_file()
}

/// `%APPDATA%\WorkHelper`，即配置与（默认）数据的根。取不到就退回用户主目录。
fn app_data_root() -> Result<PathBuf, String> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.is_empty() {
            return Ok(PathBuf::from(appdata).join(APP_DIR_NAME));
        }
    }
    // 非 Windows 或环境异常时的退路：用户主目录下
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(|home| PathBuf::from(home).join(format!(".{APP_DIR_NAME}")))
        .map_err(|_| "既取不到 APPDATA 也取不到用户主目录".to_string())
}

/// 外壳自己的配置：`%APPDATA%\WorkHelper\config.json`。
///
/// **为什么这些不进内核的 `settings` 表**：
///   · `dataDir` 决定了内核的库在哪，**内核启动前就要知道**，不能反过来问内核
///   · 悬浮组件的位置/透明度是"**这台机器的窗口状态**"，属于外壳职责；
///     放进库会跟着备份/同步跑到别的机器上，而那里的屏幕布局根本不同
///
/// 于是配置只有一处：这个文件。**不设第二个地方存同样的东西** ——
/// 那正是本项目第一类错误（同一规则写在两处必然背离）。
#[derive(Debug, Clone)]
struct ShellConfig {
    /// 数据目录覆盖值（未设则按形态取默认）
    data_dir: Option<PathBuf>,
    /// 悬浮组件左上角坐标（未设则首次运行时定位到屏幕右下角）
    widget_pos: Option<(i32, i32)>,
    /// 悬浮组件不透明度 0.3–1.0
    widget_opacity: f64,
    /// 悬浮组件是否常驻显示（托盘可关）
    widget_visible: bool,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            data_dir: None,
            widget_pos: None,
            widget_opacity: 0.92,
            // 需求 F-17：默认常驻显示（托盘菜单可关闭）
            widget_visible: true,
        }
    }
}

impl ShellConfig {
    fn load(root: &Path) -> Self {
        let mut config = Self::default();
        // 读不到或解析失败就用默认值：**一个坏掉的配置文件不该让程序完全起不来**。
        // 但损坏本身要说出来，否则用户改错了配置只会觉得"设置不生效"。
        let path = root.join("config.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return config;
        };
        let Ok(json) = Json::parse(&text) else {
            eprintln!("[shell] ✗ 配置文件解析失败，已按默认值继续：{}", path.display());
            return config;
        };

        if let Some(value) = json.get("dataDir").and_then(Json::as_str) {
            if !value.trim().is_empty() {
                config.data_dir = Some(PathBuf::from(value));
            }
        }
        if let Some(value) = json.get("widgetOpacity").and_then(Json::as_f64) {
            // 夹到可用区间：0 会让组件完全看不见，用户以为是 bug
            config.widget_opacity = value.clamp(0.3, 1.0);
        }
        if let Some(value) = json.get("widgetVisible").and_then(Json::as_bool) {
            config.widget_visible = value;
        }
        let x = json.get("widgetX").and_then(Json::as_i64);
        let y = json.get("widgetY").and_then(Json::as_i64);
        if let (Some(x), Some(y)) = (x, y) {
            config.widget_pos = Some((x as i32, y as i32));
        }
        config
    }

    /// 写回配置文件。
    ///
    /// **失败只提示不中断**：位置记不住最多是下次回到默认位置，
    /// 而为此让"移动悬浮组件"这个操作报错，代价更大。
    fn save(&self, root: &Path) {
        let mut out = String::from("{\n");
        out.push_str(&format!(
            "  \"dataDir\": {},\n",
            match &self.data_dir {
                Some(path) => json_string(&path.to_string_lossy()),
                None => "null".to_string(),
            }
        ));
        match self.widget_pos {
            Some((x, y)) => out.push_str(&format!("  \"widgetX\": {x},\n  \"widgetY\": {y},\n")),
            None => out.push_str("  \"widgetX\": null,\n  \"widgetY\": null,\n"),
        }
        out.push_str(&format!("  \"widgetOpacity\": {},\n", self.widget_opacity));
        out.push_str(&format!("  \"widgetVisible\": {}\n", self.widget_visible));
        out.push_str("}\n");

        let path = root.join("config.json");
        if let Err(error) = std::fs::create_dir_all(root)
            .and_then(|()| std::fs::write(&path, out))
        {
            eprintln!("[shell] ✗ 配置写入失败（{}）：{error}", path.display());
        }
    }
}

/// 把字符串转成 JSON 字面量（转义引号、反斜杠与控制字符）。
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 极小的 JSON 值类型 + 解析器。
///
/// **为什么自己写而不是引入 serde_json**：本项目至今**零第三方依赖**
/// （内核连 `node_modules` 都没有），而这里只需要读 5 个字段。
/// 引入 serde 会带来一棵依赖树、更长的编译时间，与项目风格不符。
///
/// **为什么不用"按字段名 find 子串"**（那是原来的做法）：
/// 它对付单个字段够用，但字段一多就会互相干扰 —— 例如 `widgetX` 会匹配到
/// 出现在它前面的别的键的值里。字段变多时必须换成真解析。
#[derive(Debug, Clone)]
enum Json {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    fn parse(text: &str) -> Result<Self, String> {
        // 容忍 UTF-8 BOM。
        //
        // **不是理论问题**：Windows 记事本保存 UTF-8 文件时会加 BOM，
        // 而配置文件正是要用户手工编辑的东西。不处理的话，
        // 用户改完保存、重开程序，只会看到"设置不生效" ——
        // 而真实原因是一个他看不见的字节。（实测：PowerShell 的
        // `Set-Content -Encoding utf8` 与记事本都会加。）
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let bytes: Vec<char> = text.chars().collect();
        let mut at = 0usize;
        let value = Self::parse_value(&bytes, &mut at)?;
        Ok(value)
    }

    fn skip_ws(chars: &[char], at: &mut usize) {
        while *at < chars.len() && chars[*at].is_whitespace() {
            *at += 1;
        }
    }

    fn parse_value(chars: &[char], at: &mut usize) -> Result<Self, String> {
        Self::skip_ws(chars, at);
        let Some(&ch) = chars.get(*at) else {
            return Err("意外的结尾".to_string());
        };
        match ch {
            '{' => Self::parse_object(chars, at),
            '[' => Self::parse_array(chars, at),
            '"' => Ok(Json::Str(Self::parse_string(chars, at)?)),
            't' | 'f' => Self::parse_bool(chars, at),
            'n' => {
                Self::expect(chars, at, "null")?;
                Ok(Json::Null)
            }
            _ => Self::parse_number(chars, at),
        }
    }

    fn parse_object(chars: &[char], at: &mut usize) -> Result<Self, String> {
        *at += 1; // 吃掉 '{'
        let mut entries = Vec::new();
        loop {
            Self::skip_ws(chars, at);
            if chars.get(*at) == Some(&'}') {
                *at += 1;
                return Ok(Json::Object(entries));
            }
            let key = Self::parse_string(chars, at)?;
            Self::skip_ws(chars, at);
            Self::expect(chars, at, ":")?;
            let value = Self::parse_value(chars, at)?;
            entries.push((key, value));
            Self::skip_ws(chars, at);
            match chars.get(*at) {
                Some(&',') => *at += 1,
                Some(&'}') => {
                    *at += 1;
                    return Ok(Json::Object(entries));
                }
                _ => return Err("对象里缺少 , 或 }".to_string()),
            }
        }
    }

    fn parse_array(chars: &[char], at: &mut usize) -> Result<Self, String> {
        *at += 1; // 吃掉 '['
        let mut items = Vec::new();
        loop {
            Self::skip_ws(chars, at);
            if chars.get(*at) == Some(&']') {
                *at += 1;
                return Ok(Json::Array(items));
            }
            items.push(Self::parse_value(chars, at)?);
            Self::skip_ws(chars, at);
            match chars.get(*at) {
                Some(&',') => *at += 1,
                Some(&']') => {
                    *at += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err("数组里缺少 , 或 ]".to_string()),
            }
        }
    }

    fn parse_string(chars: &[char], at: &mut usize) -> Result<String, String> {
        Self::skip_ws(chars, at);
        if chars.get(*at) != Some(&'"') {
            return Err("期望字符串".to_string());
        }
        *at += 1;
        let mut out = String::new();
        while let Some(&ch) = chars.get(*at) {
            *at += 1;
            match ch {
                '"' => return Ok(out),
                '\\' => {
                    let Some(&esc) = chars.get(*at) else {
                        return Err("转义序列不完整".to_string());
                    };
                    *at += 1;
                    match esc {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'b' => out.push('\u{0008}'),
                        'f' => out.push('\u{000c}'),
                        'u' => {
                            // \uXXXX：只处理基本平面（配置里只会有路径等 ASCII/中文）
                            let mut code = 0u32;
                            for _ in 0..4 {
                                let Some(&hex) = chars.get(*at) else {
                                    return Err("\\u 转义不完整".to_string());
                                };
                                *at += 1;
                                let digit = hex.to_digit(16).ok_or("\\u 后面不是十六进制")?;
                                code = code * 16 + digit;
                            }
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        other => return Err(format!("不认识的转义 \\{other}")),
                    }
                }
                c => out.push(c),
            }
        }
        Err("字符串没有收尾引号".to_string())
    }

    fn parse_bool(chars: &[char], at: &mut usize) -> Result<Self, String> {
        if chars.get(*at) == Some(&'t') {
            Self::expect(chars, at, "true")?;
            Ok(Json::Bool(true))
        } else {
            Self::expect(chars, at, "false")?;
            Ok(Json::Bool(false))
        }
    }

    fn parse_number(chars: &[char], at: &mut usize) -> Result<Self, String> {
        let start = *at;
        if chars.get(*at) == Some(&'-') {
            *at += 1;
        }
        while matches!(chars.get(*at), Some(c) if c.is_ascii_digit() || *c == '.' || *c == 'e' || *c == 'E' || *c == '+' || *c == '-') {
            *at += 1;
        }
        let text: String = chars[start..*at].iter().collect();
        text.parse::<f64>()
            .map(Json::Number)
            .map_err(|_| format!("不是合法数字：{text}"))
    }

    fn expect(chars: &[char], at: &mut usize, literal: &str) -> Result<(), String> {
        for expected in literal.chars() {
            if chars.get(*at) != Some(&expected) {
                return Err(format!("期望 {literal}"));
            }
            *at += 1;
        }
        Ok(())
    }

    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(value) => Some(value),
            _ => None,
        }
    }

    fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(value) => Some(*value),
            _ => None,
        }
    }

    fn as_i64(&self) -> Option<i64> {
        self.as_f64().map(|value| value as i64)
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(value) => Some(*value),
            _ => None,
        }
    }
}

/// 确认目录存在且**真的可写**。
///
/// **必须实际写一个文件验证**：只检查 `is_dir()` 会漏掉"目录在但只读"的情况
/// （安装在 `Program Files`、被安全软件锁、只读盘），
/// 那种情况要等到建库时才失败，错误信息还指向数据库而不是权限。
fn ensure_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建不出目录 {}：{e}", dir.display()))?;
    let probe = dir.join(".write-probe");
    std::fs::write(&probe, b"ok").map_err(|e| {
        format!("数据目录不可写：{}（{e}）", dir.display())
    })?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// 解析运行时路径：内核源码树 + 数据目录。
fn resolve_runtime_paths() -> Result<RuntimePaths, String> {
    let dev = detect_dev_mode();

    // 内核源码树与资源目录：
    //   开发态 —— 编译时注入的仓库根
    //   打包态 —— <可执行文件目录>\resources（含 node/ 与 src/）
    let (kernel_root, resources_dir) = if dev {
        (find_repo_root()?, None)
    } else {
        let exe = std::env::current_exe().map_err(|e| format!("取不到自身路径：{e}"))?;
        let dir = exe.parent().ok_or("可执行文件没有父目录")?.to_path_buf();
        let resources = dir.join("resources");
        let entry = resources.join("src").join("ui").join("main.ts");
        if !entry.is_file() {
            return Err(format!(
                "打包形态下找不到内核资源：期望 {} 存在。安装可能不完整，建议重新安装。",
                entry.display()
            ));
        }
        // 内核根就是 resources：内核用 import.meta.dirname 推导它自己的相对基准，
        // 而项目里所有对内核根的引用都以 "src/..." 为前缀（含编译时注入的那份）
        (resources.clone(), Some(resources))
    };

    // 数据目录优先级：用户配置 > 形态默认值
    //
    // **两种形态的默认值不同，这是有意的**：
    //   · 开发态 → 仓库的 `data/` —— 保持开发者已有的数据、也让测试可预期。
    //     若开发态也跳到 %APPDATA%，表现是"我的数据不见了"（其实是换了库），
    //     而且与"浏览器里开发照旧"这个验收标准直接冲突。
    //   · 打包态 → `%APPDATA%\WorkHelper\data` —— 安装目录不可写，必须换地方。
    let root = app_data_root()?;
    let config = ShellConfig::load(&root);
    let data_dir = config.data_dir.clone().unwrap_or_else(|| {
        if dev {
            kernel_root.join("data")
        } else {
            root.join("data")
        }
    });
    ensure_writable(&data_dir)?;

    Ok(RuntimePaths {
        kernel_root,
        resources_dir,
        data_dir,
        dev,
        config_root: root,
        config,
    })
}

fn main() {
    let started = Instant::now();

    let paths = match resolve_runtime_paths() {
        Ok(value) => value,
        Err(message) => {
            eprintln!("[shell] 致命错误：{message}");
            std::process::exit(1);
        }
    };
    println!(
        "[shell] 形态      = {}",
        if paths.dev { "开发态" } else { "打包态" }
    );
    println!("[shell] 内核根目录 = {}", paths.kernel_root.display());
    println!(
        "[shell] 随包 Node  = {}",
        match &paths.resources_dir {
            Some(dir) => dir.join("node").join("node.exe").display().to_string(),
            None => "（开发态，用系统 Node）".to_string(),
        }
    );
    println!("[shell] 数据目录   = {}", paths.data_dir.display());
    println!(
        "[shell] 悬浮组件   = {}，不透明度 {:.2}",
        if paths.config.widget_visible { "常驻显示" } else { "隐藏" },
        paths.config.widget_opacity
    );

    // 配置要交给 Tauri 状态（窗口事件回调里要读写它），先把所有权取出来。
    // `spawn_kernel` 之后就不再用 `paths.config`，因此这里 clone 一份即可。
    let config_for_state = paths.config.clone();
    let config_root_for_state = paths.config_root.clone();

    // 端口已被占用时不重复拉起 —— 内核是单实例设计，
    // 第二个进程会因端口冲突失败（或更糟：两个进程写同一个库）
    let child = if port_in_use() {
        println!("[shell] 端口 {PORT} 已有服务在跑，复用它（不重复拉起内核）");
        None
    } else {
        match spawn_kernel(&paths) {
            Ok(child) => Some(child),
            Err(message) => {
                eprintln!("[shell] 致命错误：{message}");
                std::process::exit(1);
            }
        }
    };

    if child.is_some() {
        match wait_until_ready(started) {
            Ok(elapsed) => println!("[shell] 内核就绪，耗时 {} ms", elapsed.as_millis()),
            Err(message) => {
                eprintln!("[shell] 致命错误：{message}");
                std::process::exit(1);
            }
        }
    }

    let mut builder = tauri::Builder::default();
    builder = builder.manage(NodeServer(Mutex::new(child)));

    // 全局热键（B2-b）。
    //
    // 在 Rust 侧注册并处理，**不经过前端** —— 因此不需要 capabilities 授权：
    // Tauri 的权限系统管的是"前端能调哪些命令"，这里压根没有前端调用。
    //
    // 注册失败必须**明确报错**而不是静默失效（需求 F-05）：
    // 热键被别的软件占用时用户唯一的感受就是"按了没反应"，那是最难排查的形态。
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            // 只在**按下**时响应。不判断的话按键释放会再触发一次，
            // 表现为"窗口闪两下"。
            if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }

            // 两个热键共用一个 handler（全局只有一个 handler），因此必须分辨是哪一个。
            // 用 `matches` 比对解析结果，字符串常量只有一份，不另抄一遍键名 ——
            // 抄一遍就是"同一规则写在两处"。
            let capture = HOTKEY_CAPTURE.parse::<tauri_plugin_global_shortcut::Shortcut>();
            if capture.is_ok_and(|s| s == *shortcut) {
                open_capture_window(app);
                return;
            }

            let note = HOTKEY_NOTE.parse::<tauri_plugin_global_shortcut::Shortcut>();
            if note.is_ok_and(|s| s == *shortcut) {
                request_note_input(app);
            }
        })
        .build();

    let app = builder
        .invoke_handler(tauri::generate_handler![
            hide_capture_window,
            open_capture_window_command,
            take_widget_command,
            notify_widget_refresh,
            report_note_result,
            collapse_widget,
            save_widget_position,
        ])
        // 悬浮组件的指令槽（进入输入 / 重画 / 选焦点）。
        .manage(WidgetCommandSlot::new())
        // 悬浮组件是否为输入态。窗口失焦时要据此决定"收起"还是"什么都不做"。
        .manage(WidgetMode(std::sync::atomic::AtomicBool::new(false)))
        // "窗口动过、位置还没落盘"的标记（拖动时节流用）。
        .manage(WidgetMoveSaver(std::sync::atomic::AtomicBool::new(false)))
        // 外壳配置（数据目录 + 悬浮组件的位置/透明度/可见性）。
        .manage(ShellState {
            config: std::sync::Mutex::new(config_for_state),
            config_root: config_root_for_state,
        })
        .setup(move |app| {
            println!(
                "[shell] 应用就绪，从进程启动算起 {} ms",
                started.elapsed().as_millis()
            );

            // 关闭替身由 WebviewWindowBuilder 的 initialization_script 注入
            // （见 open_capture_window 的说明）—— 必须早于页面脚本，
            // 因此不能放在这里 eval。

            // 悬浮组件（需求 F-17）：**默认常驻显示**（用户确认），
            // 位置取上次拖动保存的坐标。
            //
            // 放在 setup 里而不是配置文件里声明：它的位置与可见性来自配置，
            // 而配置要到运行时才读得到，声明式配置表达不了"上次拖到哪"。
            if let Err(error) = create_widget_window(app.handle()) {
                // 建不出来不该让整个程序起不来 —— 主窗口与热键仍然可用
                eprintln!("[shell] ✗ {error}");
            }

            // 悬浮组件位置的落盘线程。
            //
            // 拖动时 `Moved` 每秒触发几十次，逐次写文件既无意义又伤盘。
            // 因此事件只置标记，这里每 400ms 检查一次并写最终位置 ——
            // 拖动停手后最多 400ms 就存好，而写盘次数从"几十次/秒"降到"一次/次拖动"。
            let saver_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(400));
                let Some(flag) = saver_handle.try_state::<WidgetMoveSaver>() else {
                    continue;
                };
                // swap：只处理"有新位置"的情况，没动过就什么都不做
                if flag.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    persist_widget_position(&saver_handle);
                }
            });

            // 这里注册热键；冲突时 give up 并说清怎么办
            //
            // 两个热键分别注册、分别报错：一个被占用不该影响另一个可用，
            // 而"哪个失败了"对用户来说是关键信息。
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            for (label, hotkey) in [("快记", HOTKEY_CAPTURE), ("记一笔", HOTKEY_NOTE)] {
                match app.global_shortcut().register(hotkey) {
                    Ok(()) => println!("[shell] 全局热键已注册（{label}）：{hotkey}"),
                    Err(error) => {
                        eprintln!("[shell] ✗ 全局热键 {hotkey}（{label}）注册失败：{error}");
                        eprintln!("[shell]   多半是被其它软件占用。可改 main.rs 里的热键常量换一个组合。");
                    }
                }
            }
            Ok(())
        })
        .plugin(shortcut_plugin)
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败");

    app.run(move |app_handle, event| {
        if let RunEvent::WindowEvent { label, event, .. } = &event {
            if label == WIDGET_LABEL {
                match event {
                    // 拖动结束：把新位置写进配置。
                    //
                    // **为什么在这里而不是页面里**：拖动由 Tauri 交给操作系统处理，
                    // 页面侧无法知道"系统级拖动什么时候结束"，
                    // 在那里猜时机会把位置存成半路的值（实测的直觉：
                    // 页面 mouseup 往往早于系统拖动结束）。
                    // `Moved` 是窗口真的移完之后才来的事件。
                    WindowEvent::Moved(_) => {
                        // 移动过程会连续触发，因此**节流**：只记"最新位置"，
                        // 由下面那个定时器统一落盘，避免每秒写几十次文件。
                        if let Some(state) = app_handle.try_state::<WidgetMoveSaver>() {
                            state.0.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    }

                    // 悬浮组件失焦：**只在输入态才收起**。
                    //
                    // 为什么不无条件收起：idle 态的组件本来就不该有焦点
                    // （F-17 要求不抢焦点），失焦是它的常态，
                    // 收起它等于组件刚显示就被藏起来。
                    //
                    // 为什么失焦即收起而不是保持展开：用户点了别处说明改主意了，
                    // 让展开态一直挡着屏幕更糟（用户确认过这个取舍）。
                    WindowEvent::Focused(false) => {
                        if let Some(mode) = app_handle.try_state::<WidgetMode>() {
                            if mode.is_input() {
                                mode.set(false);
                                // 页面也要知道 —— 它据此把输入行收起来并清空
                                if let Some(window) = app_handle.get_webview_window(WIDGET_LABEL)
                                {
                                    let _ = window
                                        .eval("document.body.classList.remove('mode-input')");
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        // 关键：**任何**退出路径都要收掉子进程，包括窗口被关闭、
        // 用户从任务管理器结束、以及应用 panic。
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            let state = app_handle.state::<NodeServer>();
            let mut guard = state.0.lock().expect("锁被污染");
            if let Some(mut child) = guard.take() {
                kill_tree(&mut child);
            }
        }
    });
}
