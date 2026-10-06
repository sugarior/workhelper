//! 工作秘书的桌面外壳。
//!
//! 职责（按重要程度）：
//!   1. 找到 Node 运行时，拉起 `src/ui/main.ts` 这个内核服务，等它就绪
//!   2. 承载界面：主窗口、快记窗、悬浮组件（都走 Tauri 的应用协议）
//!   3. 全局热键：`Ctrl+Alt+Space` 快记、`Ctrl+Shift+Space` 记一笔
//!   4. 系统托盘与"关闭主窗口不退出进程"（**常驻桌面这个形态的落点**）
//!   5. **任何**退出路径都干净地收掉整棵子进程树（不留僵尸 node）
//!
//! 架构决策（plan §B1）：外壳**不碰数据层**，内核一行不改，界面走 HTTP。
//! 因此这个文件里没有 SQL、没有业务规则 —— 它只管进程、窗口、热键、托盘。

// 发布版**不要控制台窗口**：带一个黑框的 GUI 程序会让人以为装错了东西。
//
// 用条件编译而不是无条件设 `windows_subsystem = "windows"`：
//   · 开发时保留控制台 —— 外壳日志（"内核已就绪，耗时 …"）是排查的主要依据，
//     `println!` 得有个地方去
//   · 发布时隐藏它 —— 用户不该看到一屏日志
//
// **为什么写在这里而不是 Cargo.toml**：那是给库设 crate 类型用的；
// 二进制 crate 用这个属性最直接，而且能按 debug/release 分别处理。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        .stdin(Stdio::null());

    // 内核的输出去哪。
    //
    // **两种形态必须分开处理，否则发布态会瞎**：
    //
    // | 形态 | 外壳有没有控制台 | 内核输出 |
    // | --- | --- | --- |
    // | 开发态 | 有（控制台子系统） | **继承** → 直接打在眼前，排查最快 |
    // | 发布态 | 没有（GUI 子系统） | **落盘** → 写到数据目录下的 `workhelper.log` |
    //
    // 发布态若也 `inherit`，内核那十几处 `console.log`（含端口、数据库路径、
    // 启动失败原因）**会全部消失** —— 用户报"打不开"时手上一点线索都没有。
    // 这次是差点就这么改过去。
    //
    // 日志放**数据目录**而不是安装目录：安装目录（`Program Files` 或
    // `%LOCALAPPDATA%\Programs`）对普通用户不可写，而数据目录已经被
    // 验证过可写（见 `resolve_runtime_paths`）。
    //
    // 用**追加**而不是覆盖：多次启动的记录留在同一个文件里，
    // "上次为什么失败、这次为什么能起"才有得比。定期清理留给以后 ——
    // 只在真有体积问题时才做，现在加是过度设计。
    if cfg!(debug_assertions) {
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    } else {
        let log_path = paths.data_dir.join("workhelper.log");
        match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(file) => {
                // try_clone：两个流各要一个句柄，`Stdio::from` 会取走所有权
                let for_stderr = file.try_clone();
                command.stdout(Stdio::from(file));
                match for_stderr {
                    Ok(handle) => {
                        command.stderr(Stdio::from(handle));
                    }
                    // 只拿到一个句柄不算失败：stdout 已经能落盘，stderr 退回丢弃
                    Err(_) => {
                        command.stderr(Stdio::null());
                    }
                }
            }
            Err(error) => {
                // 开不了日志文件**不该让程序起不来** —— 内核本身还能跑、界面还能用。
                // 但必须留下痕迹：这是发布态唯一的诊断线索。
                eprintln!("[shell] ✗ 无法打开内核日志 {log_path:?}：{error}");
                command.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
    }

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

/// 关闭快记窗（由页面里的 `window.close()` 替身与 `Esc` 调用）。
///
/// **是销毁（`destroy`）而不是隐藏（`hide`）** —— 与 `open_capture_window` 的
/// "销毁重建"配套：这样每次唤起都是全新页面，`.closing` 与 `finished` 一类
/// 残留状态不可能存在。隐藏复用的时代已经结束了（代价只是每次约 380ms）。
///
/// 用 `destroy` 而不是 `close`：`close` 会先发 `CloseRequested` 且是异步的，
/// 实测会出现"窗口没真的销毁"（见 `open_capture_window` 里的记录）。
#[tauri::command]
fn hide_capture_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
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

/// "正在重建快记窗"的守卫。
///
/// **为什么需要**：重建要经"后台线程等 80ms → 回主线程建窗口"两步。
/// 这期间若又按了一次热键或点了按钮，就会排队第二次重建 ——
/// 两次撞在同一个 label 上，后一次必然失败。
/// 置位期间忽略后续请求：用户连按几下，得到的是**一个**窗口，不是一串错误。
struct CaptureRebuilding(std::sync::atomic::AtomicBool);

/// 打开快记窗：**每次都销毁重建**。
///
/// **必须走应用协议**（`WebviewUrl::App`）而不是外部 http 地址 ——
/// 后者没有 Tauri 的 JS 通道，`window.close` 替身注入不进去（见 `CLOSE_SHIM` 的说明）。
///
/// **为什么是"销毁重建"而不是"隐藏 + 重载"**：
/// 复用窗口会留下页面级状态，而清理它们的手段都不可靠 ——
///   · `.closing` 类（`opacity: 0` + 动画 `forwards` 保持）→ 再唤出时**看得见框、看不见内容**
///     （用户实测报告："快记框会崩溃，灰屏"）
///   · `capture.js` 的模块级 `finished = true` → 保存逻辑开头 `if (finished) return`，
///     于是**再也不能写入**
///
/// 曾经用 `window.eval("location.reload()")` 清理，但 `eval` 的可靠性在本项目
/// 已经栽过三次。**重建不依赖页面侧任何机制**：新窗口 = 新页面 = 状态必然干净。
///
/// ## 为什么"总是"异步，而不是只在有旧窗口时异步
///
/// `destroy()` 把销毁动作**投给主线程的事件循环**，而我们从主线程紧接着
/// 同步调 `build()` —— 事件循环没机会处理那条消息，旧窗口还在，重建报
/// `a webview with label 'capture' already exists`。
///
/// 更关键的是**调用来源不同、结果也不同**：
///   · 热键 —— 由外壳自己的回调触发，主线程当时是"空闲"的
///   · 「＋ 快记」按钮 —— 由主窗口通过 **IPC 命令**触发，**我们正处在处理命令的过程中**
///
/// 后者正是用户实测到的："热键呼出没问题，**点按钮呼出的还是会崩溃**"。
/// 因此这里**无条件**走"后台线程等待 → 回主线程建窗口"，
/// 两条路径行为一致 —— 不靠"当时主线程忙不忙"这种不可控的判断。
fn open_capture_window(app: &tauri::AppHandle) {
    // 重建进行中：忽略这次请求，避免两次重建撞在同一个 label 上
    if let Some(guard) = app.try_state::<CaptureRebuilding>() {
        if guard.0.swap(true, std::sync::atomic::Ordering::SeqCst) {
            println!("[shell] 快记窗正在重建，忽略这次请求");
            return;
        }
    }

    // 先隐藏旧窗口：用户立刻看不到它，不必等销毁完成
    if let Some(existing) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = existing.hide();
        if let Err(error) = existing.destroy() {
            eprintln!("[shell] ✗ 销毁旧快记窗失败：{error}");
        }
    }

    let handle = app.clone();
    let began = Instant::now();
    std::thread::spawn(move || {
        // 让出事件循环，等销毁真正完成。
        // **这个 sleep 是必需的，不是"等一等碰运气"**：销毁是主线程上的一次
        // 事件处理，而我们正占着主线程 —— 必须先返回，它才可能发生。
        std::thread::sleep(Duration::from_millis(80));

        // 回主线程建窗口：Tauri 的窗口 API 必须在主线程调用
        let for_main = handle.clone();
        let result = handle.run_on_main_thread(move || {
            build_capture_window(&for_main, began);
            // 无论成败都要放开守卫，否则一次失败会让此后所有唤出都被忽略
            if let Some(guard) = for_main.try_state::<CaptureRebuilding>() {
                guard.0.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        });
        if let Err(error) = result {
            eprintln!("[shell] ✗ 无法回到主线程创建快记窗：{error}");
            if let Some(guard) = handle.try_state::<CaptureRebuilding>() {
                guard.0.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
}

/// 真正创建快记窗。单独一个函数，因为"先销毁再建"的路径需要延后调用它。
fn build_capture_window(app: &tauri::AppHandle, began: Instant) {
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
            println!("[shell] 快记窗已就绪，耗时 {} ms", began.elapsed().as_millis());
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
    ///
    /// **当前没有调用方**：页面自己会判断（有焦点 → 进输入态；没焦点 → 弹选焦点），
    /// 因此外壳不需要发这条指令。保留它是为了让"外壳主动要求页面进选焦点态"
    /// 这条路随时可用 —— 例如将来加"从托盘直接换焦点"。
    /// 删掉再回来加，成本比留着一个有注释的枚举值高。
    #[allow(dead_code)]
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

/// 悬浮组件调用：外面（主界面）该重画了。
///
/// **与 `notify_widget_refresh` 方向相反、用途对称**：那一对解决"主界面改了、组件不知道"，
/// 这一个解决"**组件改了、主界面不知道**" —— 在悬浮组件里选完焦点后，
/// 主界面顶部的聚焦条仍显示旧任务（用户实测报告："选完焦点在主页面不同步"）。
///
/// 两者都用"置标记 + 页面轮询"同一个机制，不引入第二种通信方式。
#[tauri::command]
fn notify_main_refresh(app: tauri::AppHandle) {
    if let Some(flag) = app.try_state::<MainRefreshRequest>() {
        flag.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 主界面轮询取走"该重画了"标记；返回 true 表示这次要刷新。
///
/// **取值即清零**：一次变更只触发一次重画，否则主界面会被反复重绘。
#[tauri::command]
fn take_main_refresh(state: tauri::State<'_, MainRefreshRequest>) -> bool {
    state.0.swap(false, std::sync::atomic::Ordering::SeqCst)
}

/// "主界面该重画了"的标记（悬浮组件改动了数据时置位）。
struct MainRefreshRequest(std::sync::atomic::AtomicBool);

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

/// 托盘菜单项 id。**用常量而不是散落的字符串字面量**：
/// 菜单的构造与事件处理两处都要用它们，写字面量迟早拼错一处 ——
/// 而拼错的后果是"点了没反应"，那是最难排查的形态（需求 F-05 的教训）。
mod tray_id {
    pub const CAPTURE: &str = "wh-capture";
    pub const TODAY: &str = "wh-today";
    pub const INBOX: &str = "wh-inbox";
    pub const PAUSE_REMIND: &str = "wh-pause-remind";
    pub const TOGGLE_WIDGET: &str = "wh-toggle-widget";
    pub const SETTINGS: &str = "wh-settings";
    pub const QUIT: &str = "wh-quit";
}

/// 构建托盘菜单。
///
/// **"显示/隐藏悬浮组件"的文案随当前状态变**：菜单要打开时才构建，
/// 因此每次都能反映真实状态。写死"隐藏"而组件已经是隐藏的，会让人困惑。
fn build_tray_menu(app: &tauri::AppHandle) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};

    let widget_visible = app
        .try_state::<ShellState>()
        .map(|state| state.config.lock().expect("锁被污染").widget_visible)
        .unwrap_or(true);

    let item = |id: &str, text: &str| {
        MenuItemBuilder::with_id(id, text)
            .build(app)
            .map_err(|e| format!("构建菜单项 {id} 失败：{e}"))
    };

    let capture = item(tray_id::CAPTURE, "快记")?;
    let today = item(tray_id::TODAY, "今日")?;
    let inbox = item(tray_id::INBOX, "收件箱")?;
    // 需求 F-16 原文有这一项，但**提醒功能（F-22/F-23）尚未实现**。
    // 处置：显示但**置灰**，文案里说明原因 ——
    // 比"先不放"更容易解释（用户对照需求会发现少了东西），
    // 也比"放了但点了没反应"好（那违反 F-05）。
    let pause = MenuItemBuilder::with_id(tray_id::PAUSE_REMIND, "暂停提醒（功能尚未实现）")
        .enabled(false)
        .build(app)
        .map_err(|e| format!("构建菜单项失败：{e}"))?;
    let toggle_widget = item(
        tray_id::TOGGLE_WIDGET,
        if widget_visible { "隐藏悬浮组件" } else { "显示悬浮组件" },
    )?;
    let settings = item(tray_id::SETTINGS, "设置…")?;
    let quit = item(tray_id::QUIT, "退出")?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| format!("构建分隔线失败：{e}"))?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| format!("构建分隔线失败：{e}"))?;

    MenuBuilder::new(app)
        .items(&[
            &capture,
            &today,
            &inbox,
            &pause,
            &sep1,
            &toggle_widget,
            &settings,
            &sep2,
            &quit,
        ])
        .build()
        .map_err(|e| format!("构建托盘菜单失败：{e}"))
}

/// 创建系统托盘（需求 F-16）。
fn create_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::tray::TrayIconBuilder;

    let menu = build_tray_menu(app)?;

    TrayIconBuilder::with_id("wh-tray")
        // 图标从编译期嵌入的字节解码：**不依赖运行时的文件路径** ——
        // 打包后图标在资源里，写路径就得处理开发态/打包态两种位置。
        .icon(
            tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                .map_err(|e| format!("托盘图标解码失败：{e}"))?,
        )
        .tooltip("工作秘书")
        .menu(&menu)
        // **左键不弹菜单**：左键改为直接显示主界面（用户建议）。
        // 需求 F-16 原文是"托盘图标 + **右键菜单**"，因此左键留给主界面
        // 与那一条一致；而"左键弹菜单"会让"左键显示主界面"根本无从实现。
        //
        // 实测背景：原来设的是 `true`，结果**左键弹菜单后点菜单项没有反应** ——
        // 用户报告"点今日或收件箱都不行"。把左键让出来同时解决了那个问题。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_tray_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // 用 `Up` 而不是 `Down`：与按钮的语义一致（抬手才算点完），
                // 也避免按住不放时反复触发。
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| format!("构建托盘失败：{e}"))?;

    println!("[shell] 系统托盘已就绪（左键显示主界面 · 右键菜单）");
    Ok(())
}

/// 左键点托盘：主窗口可见就收起，不可见就显示。
///
/// **为什么做成开关而不是"总是显示"**：用户点托盘的意图通常是
/// "我要看看它"；而窗口本来就在最前面时，再"显示"一次**看不出任何变化** ——
/// 那会让人以为点了没反应。做成开关则每次点击都有可见结果。
fn toggle_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[shell] ✗ 找不到主窗口");
        return;
    };
    // `is_visible()` 可能失败；失败时按"显示"处理 ——
    // 那是最符合"我点了托盘想看到它"的意图
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        let _ = window.hide();
        println!("[shell] 托盘：主窗口已收起");
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        println!("[shell] 托盘：主窗口已显示");
    }
}

/// 托盘菜单点击处理。
///
/// **每个分支都要有可见结果**：点了没反应是最难排查的形态（F-05）。
/// 因此"设置"这类还没做的功能，也明确说一句，而不是静默返回。
fn handle_tray_menu(app: &tauri::AppHandle, id: &str) {
    match id {
        tray_id::CAPTURE => open_capture_window(app),
        tray_id::TODAY => show_main_window(app, Some("today")),
        tray_id::INBOX => show_main_window(app, Some("inbox")),
        // 置灰项在正常路径下点不到；万一被系统触发，也说清楚而不是静默
        tray_id::PAUSE_REMIND => println!("[shell] 暂停提醒：功能尚未实现"),
        tray_id::TOGGLE_WIDGET => {
            let current = app
                .try_state::<ShellState>()
                .map(|state| state.config.lock().expect("锁被污染").widget_visible)
                .unwrap_or(true);
            set_widget_visible(app, !current);
            // 菜单文案要跟着变，因此重建一次
            refresh_tray_menu(app);
        }
        tray_id::SETTINGS => show_main_window(app, Some("settings")),
        tray_id::QUIT => {
            println!("[shell] 从托盘退出");
            // 走正常退出流程，让 `app.run` 的收尾逻辑收掉内核子进程
            app.exit(0);
        }
        other => eprintln!("[shell] ✗ 未知的托盘菜单项：{other}"),
    }
}

/// 重建托盘菜单，让"显示/隐藏悬浮组件"的文案与真实状态一致。
fn refresh_tray_menu(app: &tauri::AppHandle) {
    let Ok(menu) = build_tray_menu(app) else {
        return;
    };
    if let Some(tray) = app.tray_by_id("wh-tray") {
        let _ = tray.set_menu(Some(menu));
    }
}

/// 显示主窗口，必要时切到指定页签。
///
/// **切页签靠"通知页面"而不是直接改页面**：外壳碰不到页面里的模块状态。
/// 复用已有的 `MainRefreshRequest` 那套"置标记 + 页面轮询"机制，
/// 但要多带一个"切到哪一页"的信息 —— 因此这里用**独立的待切页签标记**。
fn show_main_window(app: &tauri::AppHandle, tab: Option<&str>) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[shell] ✗ 找不到主窗口");
        return;
    };
    // 窗口可能被"关闭主窗口不退出"藏起来了。
    // **每一步都报告失败**：`show()` 静默失败的表现就是"点了托盘菜单没反应"，
    // 而那正是用户报告过的问题 —— 不能再让它无声无息。
    if let Err(error) = window.show() {
        eprintln!("[shell] ✗ 显示主窗口失败：{error}");
    }
    let _ = window.unminimize();
    if let Err(error) = window.set_focus() {
        eprintln!("[shell] ✗ 聚焦主窗口失败：{error}");
    }

    if let Some(tab) = tab {
        if let Some(slot) = app.try_state::<PendingTab>() {
            match slot.0.lock() {
                Ok(mut guard) => *guard = Some(tab.to_string()),
                Err(_) => eprintln!("[shell] ✗ 待切页签的锁被污染"),
            }
        } else {
            eprintln!("[shell] ✗ PendingTab 状态未注册（内部错误）");
        }
    }
    println!(
        "[shell] 托盘：显示主窗口{}",
        tab.map(|t| format!("并切到「{t}」")).unwrap_or_default()
    );
}

/// 托盘要求主窗口切到的页签；页面轮询取走。
///
/// 用 `Mutex<Option<String>>` 而不是几个 `AtomicBool`：
/// 页签是**会增长的一组值**，用布尔量表示就得每加一页加一个标志位 ——
/// 那正是"漏了同步扩展"的温床。
struct PendingTab(std::sync::Mutex<Option<String>>);

/// 页面调用：取走"该切到哪一页"的请求；返回空串表示没有。
#[tauri::command]
fn take_pending_tab(state: tauri::State<'_, PendingTab>) -> String {
    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(_) => return String::new(),
    };
    guard.take().unwrap_or_default()
}

/// 页面调用：读外壳侧的设置（那些**不属于数据语义**、只跟这台机器有关**的设置）。
///
/// **为什么外壳设置与内核设置分开读**：两者归属不同（见 `ShellConfig` 的说明），
/// 因此没有一个"统一的设置接口"——页面分别取、合并显示。
/// 强行统一就得在某一侧做代理，多一层没有收益的转发。
#[tauri::command]
fn get_shell_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let Some(state) = app.try_state::<ShellState>() else {
        return Err("配置状态未注册（内部错误）".to_string());
    };
    let config = state.config.lock().map_err(|_| "配置锁被污染")?;
    let config_path = state.config_root.join("config.json");
    Ok(serde_json::json!({
        "widgetVisible": config.widget_visible,
        "widgetOpacity": config.widget_opacity,
        "dataDir": app.try_state::<DataDirView>().map(|d| d.0.clone()).unwrap_or_default(),
        "configPath": config_path.to_string_lossy(),
        "autostartEnabled": autostart_enabled(),
        "hotkeyCapture": HOTKEY_CAPTURE,
        "hotkeyNote": HOTKEY_NOTE,
    }))
}

/// 页面调用：改一项外壳设置。返回该设置**生效后的真实值**。
///
/// **为什么返回真实值**：设置里有些项会被夹到合法范围（例如不透明度 0.3–1.0）。
/// 只回 `ok` 的话，界面上的滑块会停在用户拖到的位置，而实际值不是那个 ——
/// 下次打开设置页会"跳一下"。回真值让界面立刻对齐。
#[tauri::command]
fn set_shell_setting(
    app: tauri::AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let Some(state) = app.try_state::<ShellState>() else {
        return Err("配置状态未注册（内部错误）".to_string());
    };

    let result = {
        let mut config = state.config.lock().map_err(|_| "配置锁被污染")?;
        match key.as_str() {
            "widgetVisible" => {
                let visible = value.as_bool().ok_or("widgetVisible 需要布尔值")?;
                config.widget_visible = visible;
                serde_json::json!(visible)
            }
            "widgetOpacity" => {
                let raw = value.as_f64().ok_or("widgetOpacity 需要数字")?;
                // 夹到可用区间：0 会让组件完全看不见，用户会以为是 bug
                let clamped = raw.clamp(0.3, 1.0);
                config.widget_opacity = clamped;
                serde_json::json!(clamped)
            }
            "autostartEnabled" => {
                let enabled = value.as_bool().ok_or("autostartEnabled 需要布尔值")?;
                set_autostart(enabled)?;
                serde_json::json!(enabled)
            }
            other => return Err(format!("不认识的设置项：{other}")),
        }
    };

    // 落盘 + 让界面生效
    {
        let config = state.config.lock().map_err(|_| "配置锁被污染")?;
        config.save(&state.config_root);
    }
    apply_shell_settings(&app);

    Ok(result)
}

/// 把当前配置应用到正在运行的界面（改了设置不该要重启才看到）。
fn apply_shell_settings(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let (visible, opacity) = {
        let Ok(config) = state.config.lock() else {
            return;
        };
        (config.widget_visible, config.widget_opacity)
    };

    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        if visible {
            let _ = window.show();
        } else {
            let _ = window.hide();
        }

        // 不透明度的生效方式：**更新窗口 URL 并导航**。
        //
        // 页面的不透明度来自 URL 参数（`widget.html?opacity=…`），那是**唯一来源**。
        // 因此改它就要改 URL —— 若改用"给页面发一条带值的新指令"，
        // 就变成"URL 一份、指令一份"，两处迟早不一致（第一类错误的典型形态）。
        //
        // **曾经这里是发一条 `Refresh`**：那条指令只重画数据，
        // **根本不会碰不透明度** —— 于是拖动滑块看不出变化（用户报告
        // "不透明度调整不明显或不生效"）。
        //
        // 用导航而不是 `eval("location.reload()")`：本次改动要改变 URL 本身
        // （查询参数不同），`reload()` 只会重载**当前** URL。
        //
        // 导航会重新加载页面，因此组件里的临时状态（选焦点面板、写了一半的内容）
        // 会被清掉。这可接受：改设置是**刻意的一次操作**，
        // 而且那个面板本来就会因为失焦而收起。
        if visible {
            // **`navigate()` 要绝对 URL**（实测：给相对地址报
            // `relative URL without a base`）。
            //
            // 做法：拿窗口**当前**的 URL 作基准，再拼上新的查询参数 ——
            // 这样不需要知道应用协议在各平台的 scheme 与 host
            // （Windows 上是 `http://tauri.localhost/`），
            // 也不会写死一个平台细节。
            let base = if let Ok(current) = window.url() {
                current.as_str().split('?').next().unwrap_or("").to_string()
            } else {
                String::new()
            };
            if base.is_empty() {
                eprintln!("[shell] ✗ 取不到悬浮组件的当前地址，无法应用不透明度");
            } else {
                let url = format!("{base}?opacity={opacity}");
                match url.parse() {
                    Ok(parsed) => {
                        if let Err(error) = window.navigate(parsed) {
                            eprintln!("[shell] ✗ 让悬浮组件应用不透明度失败：{error}");
                        }
                    }
                    // 拼出来的地址解析不了说明代码写错了，必须说出来而不是静默跳过
                    Err(error) => eprintln!("[shell] ✗ 悬浮组件地址非法（{url}）：{error}"),
                }
            }
        }
    }
    // 托盘菜单文案要跟着"显示/隐藏"变
    refresh_tray_menu(app);

    println!(
        "[shell] 设置已应用：悬浮组件 {}，不透明度 {opacity:.2}",
        if visible { "显示" } else { "隐藏" }
    );
}

/// 数据目录的只读视图（`get_shell_settings` 要报给界面看）。
struct DataDirView(String);

/// 应用名，用于 `%APPDATA%` 下的目录名与配置文件位置。
const APP_DIR_NAME: &str = "WorkHelper";

/// 注册表 Run 键的位置。**用 `HKCU` 而不是 `HKLM`**：
/// 每用户生效、**不需要管理员权限** —— 开机自启是用户自己的选择，
/// 为它要求提权是不合理的。
const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_NAME: &str = "WorkHelper";

/// 查开机自启是否已开启。
///
/// **以注册表为准，而不是以我们的期望为准**：用户可能用别的工具清掉过它。
/// 设置页显示的状态必须是他机器上的真实状态。
fn autostart_enabled() -> bool {
    let Ok(output) = Command::new("reg")
        .args(["query", AUTOSTART_KEY, "/v", AUTOSTART_NAME])
        .output()
    else {
        return false;
    };
    output.status.success()
}

/// 开启或关闭开机自启（需求 F-18）。
///
/// **失败必须报错**：注册表被策略锁住、或 `reg.exe` 不可用时，
/// 静默失败会让用户以为"已经开了"，而下次重启发现没生效 —— 那是最难查的形态。
fn set_autostart(enabled: bool) -> Result<(), String> {
    let output = if enabled {
        // 命令里带引号：安装路径可能含空格（默认装到 `%LOCALAPPDATA%\Programs\...`）
        let exe = std::env::current_exe()
            .map_err(|e| format!("取不到自身路径：{e}"))?
            .to_string_lossy()
            .to_string();
        Command::new("reg")
            .args([
                "add",
                AUTOSTART_KEY,
                "/v",
                AUTOSTART_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &format!("\"{exe}\""),
                "/f",
            ])
            .output()
    } else {
        Command::new("reg")
            .args(["delete", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/f"])
            .output()
    }
    .map_err(|e| format!("调用 reg.exe 失败：{e}"))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // 关闭时"键不存在"不算失败 —— 那正是想要的结果
        if !enabled && detail.contains("unable to find") {
            return Ok(());
        }
        return Err(format!("写注册表失败：{detail}"));
    }
    Ok(())
}

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
    /// 数组。**当前配置里没有数组字段**，但解析器要完整：
    /// 用户手写的 config.json 未来可能加数组，而"遇到数组就报错"
    /// 会让一个格式正确的文件被判成损坏。保留它比事后回来补便宜。
    #[allow(dead_code)]
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
    let data_dir_for_state = paths.data_dir.to_string_lossy().to_string();

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
            notify_main_refresh,
            take_main_refresh,
            report_note_result,
            collapse_widget,
            save_widget_position,
            take_pending_tab,
            get_shell_settings,
            set_shell_setting,
        ])
        // 数据目录的只读视图（设置页要显示"数据存在哪"）。
        .manage(DataDirView(data_dir_for_state))
        // 托盘要求主窗口切到的页签（页面轮询取走）。
        .manage(PendingTab(std::sync::Mutex::new(None)))
        // 悬浮组件的指令槽（进入输入 / 重画 / 选焦点）。
        .manage(WidgetCommandSlot::new())
        // "主界面该重画了"的标记（悬浮组件改了数据时置位）。
        .manage(MainRefreshRequest(std::sync::atomic::AtomicBool::new(false)))
        // "正在重建快记窗"的守卫（连按热键/连点按钮时只建一个窗口）。
        .manage(CaptureRebuilding(std::sync::atomic::AtomicBool::new(false)))
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

            // 系统托盘（需求 F-16）。**它是"常驻桌面"这个形态的关键一环**：
            // 没有它，"关闭主窗口不退出进程"就无从谈起。
            if let Err(error) = create_tray(app.handle()) {
                // 建不出来不该让整个程序起不来：主窗口、热键、悬浮组件都还能用，
                // 只是没有托盘入口。必须说出来 —— 否则用户会以为托盘坏了。
                eprintln!("[shell] ✗ 创建系统托盘失败：{error}");
            }

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
            // 关闭主窗口 = **收进托盘，不退出进程**（需求 F-16 的验收标准）。
            //
            // **注意它必须在 `label == WIDGET_LABEL` 判断之外**：
            // 原来这条被写在悬浮组件的分支里，而主窗口的 label 是 `"main"` ——
            // 于是 `prevent_close()` **从未执行**，主窗口被真的销毁，
            // 之后 `get_webview_window("main")` 返回 None，
            // 表现就是"关闭后托盘再也呼不出主界面"（用户报告）。
            //
            // 这个坑的形态值得记：**把"所有窗口都要处理的事"写进了"某个窗口的分支"**。
            // 单看那段代码是对的，错在它所在的位置。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if label == "main" {
                    // Tauri 默认在最后一个窗口关闭时结束应用；
                    // 不拦截的话进程照样退出 —— 那托盘就白做了。
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    println!("[shell] 主窗口已收进托盘（左键点托盘图标可再打开，或从托盘菜单退出）");
                }
                // 其它窗口（快记窗、悬浮组件）走默认行为：它们的关闭是真关闭，
                // 因为快记窗每次都是重建的，悬浮组件由托盘菜单控制显隐。
            }

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
