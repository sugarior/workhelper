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

    tauri_build::build()
}
