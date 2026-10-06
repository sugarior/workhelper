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
use tauri::{Manager, RunEvent};

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

/// 全局热键（实验 B2-b）。用户确认要 `Ctrl+Alt+Space`。
///
/// 用字符串解析而不是构造 `Modifiers`/`Code`：解析失败时错误信息里带着原始
/// 字符串，排查"哪个键没被识别"更容易；而且以后要做成可配置的，
/// 存字符串直接就能用。
const HOTKEY: &str = "ctrl+alt+Space";

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

/// 打开快记窗：不存在就建（走应用协议 + 注入关闭替身），存在就显示。
///
/// **必须走应用协议**（`WebviewUrl::App`）而不是外部 http 地址 ——
/// 后者没有 Tauri 的 JS 通道，`window.close` 替身注入不进去（见 `CLOSE_SHIM` 的说明）。
fn open_capture_window(app: &tauri::AppHandle) {
    let began = Instant::now();

    if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        println!("[shell] 快记窗唤出，耗时 {} ms", began.elapsed().as_millis());
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
/// 应用名，用于 `%APPDATA%` 下的目录名与配置文件位置。
const APP_DIR_NAME: &str = "WorkHelper";

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

/// 读取配置文件里的数据目录覆盖值。
///
/// **为什么配置放在 `%APPDATA%` 而不是数据目录里**：数据目录本身是可被改的，
/// 把"数据目录在哪"记在数据目录里就成了循环依赖 —— 改完下次就找不到配置了。
///
/// **为什么放在 `%APPDATA%` 而不是程序目录旁**：程序目录可能不可写（安装在
/// `Program Files`），而"我想改数据目录"这件事**恰恰可能就是因为程序目录不可写**。
///
/// 配置文件不存在或格式不对时**返回 None 并继续**（用默认值），
/// 因为一个坏掉的配置文件不该让程序完全起不来。
fn configured_data_dir(root: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(root.join("config.json")).ok()?;
    // 只认这一个字段，因此不引入 JSON 依赖：手写解析对固定形状足够可靠
    let key = "\"dataDir\"";
    let start = text.find(key)? + key.len();
    let rest = &text[start..];
    let colon = rest.find(':')? + 1;
    let after = rest[colon..].trim_start();
    let quote = after.find('"')? + 1;
    let tail = &after[quote..];
    let end = tail.find('"')?;
    let value = &tail[..end];
    if value.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(value))
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
    let data_dir = configured_data_dir(&root).unwrap_or_else(|| {
        if dev {
            kernel_root.join("data")
        } else {
            root.join("data")
        }
    });
    ensure_writable(&data_dir)?;

    Ok(RuntimePaths { kernel_root, resources_dir, data_dir, dev })
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
        .with_handler(|app, _shortcut, event| {
            // 只在**按下**时响应。不判断的话按键释放会再触发一次，
            // 表现为"窗口闪两下"。
            if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                open_capture_window(app);
            }
        })
        .build();

    let app = builder
        .invoke_handler(tauri::generate_handler![hide_capture_window])
        .setup(move |app| {
            println!(
                "[shell] 应用就绪，从进程启动算起 {} ms",
                started.elapsed().as_millis()
            );

            // 关闭替身由 WebviewWindowBuilder 的 initialization_script 注入
            // （见 open_capture_window 的说明）—— 必须早于页面脚本，
            // 因此不能放在这里 eval。

            // 这里注册热键；冲突时 give up 并说清怎么办
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            match app.global_shortcut().register(HOTKEY) {
                Ok(()) => println!("[shell] 全局热键已注册：{HOTKEY}"),
                Err(error) => {
                    eprintln!("[shell] ✗ 全局热键 {HOTKEY} 注册失败：{error}");
                    eprintln!("[shell]   多半是被其它软件占用。可改 HOTKEY 常量换一个组合。");
                }
            }
            Ok(())
        })
        .plugin(shortcut_plugin)
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败");

    app.run(move |app_handle, event| {
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
