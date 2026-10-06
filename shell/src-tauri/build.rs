// build script：把 tauri.conf.json 编进二进制，并注入**编译时的项目根路径**。
//
// 为什么需要注入项目根：
//   外壳运行时要找到 `src/ui/main.ts` 来拉起 Node 内核。
//   最初我打算从可执行文件位置向上找，但 `.cargo/config.toml` 把 target-dir
//   指到了 D 盘（为了不撑爆 C 盘），可执行文件因此在
//   `D:\cargo-target\...\debug\`，**永远上溯不到仓库根**。
//   两个决定各自都对，组合起来就错了。
//
//   编译时注入则不受产物位置影响：构建这个二进制时项目在哪，它就记哪。
//   运行时仍保留"向上查找"作为兜底（万一有人把二进制拷进项目内）。
fn main() {
    // CARGO_MANIFEST_DIR 指向 shell/src-tauri，仓库根是它的上两级
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 必定存在");
    let repo_root = std::path::Path::new(&manifest_dir)
        .parent() // shell/
        .and_then(|p| p.parent()) // 仓库根
        .expect("src-tauri 应有两级父目录")
        .to_path_buf();

    // 确认推导正确：找不到就是布局变了，早点报错胜过运行时才发现
    let entry = repo_root.join("src").join("ui").join("main.ts");
    if !entry.is_file() {
        panic!(
            "推断的仓库根不正确：{}（期望存在 {}）",
            repo_root.display(),
            entry.display()
        );
    }

    // 路径变化时重新运行本脚本
    println!("cargo:rerun-if-changed={}", entry.display());
    println!("cargo:rustc-env=WORKHELPER_REPO_ROOT={}", repo_root.display());

    // **界面静态资源也要声明依赖** —— 否则改 HTML/CSS/JS 后 cargo 不重跑本脚本，
    // 界面仍用上一次嵌入的旧资源。实测踩到：改了快记窗的样式与结构，
    // 重新 `cargo build` 后界面毫无变化，用 CDP 查 DOM 才确认
    // 应用协议提供的还是旧 HTML（连 `<title>` 都是旧的）。
    //
    // 这类"改了没生效"最难查的方向是去怀疑浏览器缓存 —— 实际是构建依赖没声明。
    // 因此这里把整个 frontendDist 目录纳入依赖（Tauri 的 `tauri build` 会处理，
    // 但直接用 `cargo build` 不会）。
    let static_dir = repo_root.join("src").join("ui").join("static");
    println!("cargo:rerun-if-changed={}", static_dir.display());

    // 界面资源已声明依赖；内核源码树同理 —— `resources/src/` 是打包态内核的来源，
    // 它落后于仓库就会出现"装好的程序跑旧内核"。
    //
    // **为什么放在 build.rs 而不是 tauri.conf.json 的 `beforeBuildCommand`**：
    // 那个钩子的执行目录由 tauri-cli 的 `resolve_frontend_dir()` 决定，而它靠找
    // `package.json` 来定位前端目录 —— 本仓库是零依赖设计，**根本没有 package.json**，
    // 于是它退回一个与预期不同的目录（实测算成了 `D:\projects`），
    // 相对路径 `../../scripts/...` 因此指向不存在的地方。
    // build.rs 有 `CARGO_MANIFEST_DIR`，路径推导可靠，不依赖任何外部约定。
    //
    // 用 `--src-only`：node.exe 有 100MB，只在系统 Node 升级时才需要重拷
    // （那一步由人手动跑完整模式）。这里只同步那份 400KB 左右的源码树。
    refresh_kernel_resources(&repo_root);

    tauri_build::build()
}

/// 把仓库的 `src/` 同步进 `resources/src/`，让打包态内核与仓库一致。
///
/// **失败要说出来**：这里静默失败的后果是"打包出来的程序跑旧内核"，
/// 那是最难查的一类问题（代码看着是新的，行为是旧的）。
fn refresh_kernel_resources(repo_root: &std::path::Path) {
    let script = repo_root.join("scripts").join("prepare-resources.mjs");
    if !script.is_file() {
        println!("cargo:warning=找不到 {script:?}，跳过资源刷新");
        return;
    }
    let output = std::process::Command::new("node")
        .arg(&script)
        .arg("--src-only")
        .output();
    match output {
        Ok(result) if result.status.success() => {
            // 正常路径不打印：`--src-only` 成功时没什么可说的，
            // 每次构建都刷一屏反而掩盖真正的问题
        }
        Ok(result) => {
            let stderr = String::from_utf8_lossy(&result.stderr);
            println!("cargo:warning=内核资源刷新失败（打包态会跑旧内核）：{stderr}");
        }
        Err(error) => {
            println!("cargo:warning=无法运行 node 来刷新内核资源：{error}");
        }
    }
}
