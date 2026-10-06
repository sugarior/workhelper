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

/// 找 node 可执行文件：先 PATH，再几个常见安装位置。
///
/// 为什么不写死路径：node 可能是 nvm、官方安装包、或像本机这样的自定义目录（D:\AppGallery）。
/// 写死一处，换台机器就崩。
fn find_node() -> Result<PathBuf, String> {
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
    Err("找不到 node.exe：PATH 与常见安装位置都没有".to_string())
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
fn spawn_kernel(repo_root: &Path) -> Result<Child, String> {
    let node = find_node()?;
    let entry = repo_root.join("src").join("ui").join("main.ts");
    if !entry.is_file() {
        return Err(format!("内核入口不存在：{}", entry.display()));
    }

    println!("[shell] node      = {}", node.display());
    println!("[shell] 仓库根    = {}", repo_root.display());
    println!("[shell] 内核入口  = {}", entry.display());

    let child = Command::new(&node)
        .arg(&entry)
        .arg("--port")
        .arg(PORT.to_string())
        // 把自身 PID 交给内核：外壳被强杀时（崩溃、任务管理器结束），
        // 外壳自己的退出处理不会执行，内核必须能自己发现宿主没了。
        // Windows 没有"父进程死了子进程跟着死"的默认行为 —— B2-a 实测确认过。
        .arg("--parent-pid")
        .arg(std::process::id().to_string())
        // 工作目录设为仓库根：内核自己按脚本位置推导数据目录，
        // 但保持一致可以避免"两份不同的相对路径"这类困惑
        .current_dir(repo_root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null())
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

/// 关闭信号的约定值：写进 DOM 标题，由外壳读回。
const CLOSE_SENTINEL: &str = "wh-closing";

/// 探测脚本：把"要不要关"的答案写进 `document.title`。
///
/// **为什么用改 DOM 再读回，而不是 `eval_with_callback` 回传**：
/// 实测回调时序靠不住 —— 同一个表达式在窗口刚建好时回调不触发（读到空值），
/// 4 秒后才正常返回。而 `window.title()` 是同步可读的，不依赖回调。
///
/// **为什么不用 `window.close` 替身**：那需要在页面加载**之前**完成替换，
/// 而"什么时候算加载完"在这个窗口上不好判断（实测立即 eval 会静默空操作）。
/// 读 DOM 状态则天然发生在页面就绪之后，先后顺序不需要猜。
///
/// **界面代码一行不改**：`capture.js` 保存后本来就会加 `.closing`（收起动画），
/// 这里只是观察它。
const PROBE_SCRIPT: &str = r#"
(() => {
  if (!window.__whClosed && document.body && document.body.classList.contains('closing')) {
    window.__whClosed = true;
    document.title = 'wh-closing';
  }
  return document.title;
})();
"#;

/// 快记窗关闭：轮询页面状态，看到收起动画就隐藏窗口。
///
/// **背景**：`capture.js` 靠 `window.close()` 收窗，而 Tauri 的 WebView 不认这句
/// （窗口不是 `window.open()` 开的）—— 于是它停在被 `.closing` 设成透明的状态，
/// 用户看到的是**黑屏**（空窗口的默认底色）。
///
/// 用 `hide()` 而不是 `close()`：窗口留着，下次热键唤出只需 `show()`，
/// 不必再付一次 WebView2 初始化（创建 434ms → 复用 55ms）。
fn watch_capture_close(window: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        // 先等页面加载完再开始探测：太早的 eval 是无声的空操作（实测）
        std::thread::sleep(Duration::from_millis(1500));

        loop {
            std::thread::sleep(Duration::from_millis(200));
            if !matches!(window.is_visible(), Ok(true)) {
                continue;
            }

            let _ = window.eval(PROBE_SCRIPT);
            std::thread::sleep(Duration::from_millis(120));

            if window.title().unwrap_or_default().contains(CLOSE_SENTINEL) {
                println!("[shell] 检测到快记窗已保存，隐藏它");
                let _ = window.hide();
                // 复位，供下次唤出继续使用
                let _ = window.eval("window.__whClosed = false; document.title = '快记 · WorkHelper';");
            }
        }
    });
}

/// 打开快记窗：不存在就建（注入关闭替身），存在就显示。
fn open_capture_window(app: &tauri::AppHandle) {
    let began = Instant::now();

    if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        println!("[shell] 快记窗唤出，耗时 {} ms", began.elapsed().as_millis());
        return;
    }

    let url = format!("http://127.0.0.1:{PORT}/capture");
    let parsed = match url.parse::<tauri::Url>() {
        Ok(value) => value,
        Err(error) => {
            // 端口是常量，这里失败只可能是代码写错 —— 说出来而不是静默无反应
            eprintln!("[shell] ✗ 快记窗地址非法（{url}）：{error}");
            return;
        }
    };

    let built = tauri::WebviewWindowBuilder::new(app, CAPTURE_LABEL, tauri::WebviewUrl::External(parsed))
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
        // 关键：在页面脚本之前把 window.close 换掉
        .build();

    match built {
        Ok(window) => {
            let _ = window.set_focus();
            watch_capture_close(window.clone());
            println!("[shell] 快记窗首次创建，耗时 {} ms", began.elapsed().as_millis());
        }
        Err(error) => eprintln!("[shell] ✗ 创建快记窗失败：{error}"),
    }
}

fn main() {
    let started = Instant::now();

    let repo_root = match find_repo_root() {
        Ok(root) => root,
        Err(message) => {
            eprintln!("[shell] 致命错误：{message}");
            std::process::exit(1);
        }
    };

    // 端口已被占用时不重复拉起 —— 内核是单实例设计，
    // 第二个进程会因端口冲突失败（或更糟：两个进程写同一个库）
    let child = if port_in_use() {
        println!("[shell] 端口 {PORT} 已有服务在跑，复用它（不重复拉起内核）");
        None
    } else {
        match spawn_kernel(&repo_root) {
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
