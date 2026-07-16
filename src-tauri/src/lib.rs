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
        .invoke_handler(tauri::generate_handler![cli_open_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
