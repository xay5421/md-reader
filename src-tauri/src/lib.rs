use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 前端同步过来的"有未保存修改"标记。
///
/// 关闭确认必须放在 Rust 侧处理：如果用 JS 的 onCloseRequested，
/// 一旦 WebView2 渲染进程被系统挂起/崩溃（长时间放置、多开共享的
/// 浏览器进程被杀都会触发，表现为窗口黑屏），关闭事件就永远得不到
/// JS 回应，窗口再也关不掉。Rust 侧处理则不依赖 webview 存活。
struct AppState {
    dirty: AtomicBool,
}

#[tauri::command]
fn set_dirty(state: tauri::State<'_, AppState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::Relaxed);
}

/// Returns the file path passed on the command line (double-click / "open with"),
/// if any.
#[tauri::command]
fn cli_open_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| {
            let p = std::path::Path::new(arg);
            p.is_file()
        })
        .map(|p| {
            std::fs::canonicalize(&p)
                .map(|c| c.to_string_lossy().trim_start_matches(r"\\?\").to_string())
                .unwrap_or(p)
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            dirty: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![cli_open_path, set_dirty])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let dirty = window.state::<AppState>().dirty.load(Ordering::Relaxed);
                if !dirty {
                    return; // 无未保存修改：直接放行关闭
                }
                api.prevent_close();
                let win = window.clone();
                window
                    .dialog()
                    .message("当前文件有未保存的修改，放弃这些修改吗？")
                    .title("md-reader")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::YesNo)
                    .show(move |discard| {
                        if discard {
                            // destroy 跳过 CloseRequested，避免再次弹确认
                            let _ = win.destroy();
                        }
                    });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
