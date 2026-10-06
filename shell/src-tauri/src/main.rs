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

    // 窗口在配置里就是可见的，因此这里只记录一个时间点，不调用 show()。
    // 先用 `visible: false` 再 show() 会在启动时闪一下白屏 —— 那是 B2-c 要测的延迟问题，
    // 现在不引入这个变量。
    let app = builder
        .setup(move |_app| {
            println!(
                "[shell] 应用就绪，从进程启动算起 {} ms",
                started.elapsed().as_millis()
            );
            Ok(())
        })
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
