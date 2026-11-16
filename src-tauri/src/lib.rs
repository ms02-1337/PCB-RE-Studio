pub mod commands;
pub mod project;

use tauri::Manager;

#[cfg(all(feature = "desktop-test", not(debug_assertions)))]
compile_error!("desktop-test must never be enabled in production builds");
#[derive(serde::Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
}
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "PCB RE Studio",
        version: env!("CARGO_PKG_VERSION"),
    }
}
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::ProjectState::default())
        .setup(|app| {
            // Any staged assets from a previous session are unreferenced now.
            if let Ok(cache) = app.path().app_cache_dir() {
                let staging = project::staging_for(&cache);
                if let Err(error) = project::assets::clear_staging(&staging) {
                    eprintln!("failed to clear asset staging: {error}");
                }
            }
            Ok(())
        });
    #[cfg(feature = "desktop-test")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .invoke_handler(tauri::generate_handler![
            app_info,
            commands::project_new,
            commands::project_open,
            commands::project_import_copy,
            commands::project_save,
            commands::project_save_as,
            commands::project_close,
            commands::project_export_copy,
            commands::project_export_html,
            commands::project_delete,
            commands::asset_import,
            commands::asset_import_clipboard_image,
            commands::asset_read,
            commands::asset_export
        ])
        .run(tauri::generate_context!())
        .expect("failed to launch PCB RE Studio");
}
#[cfg(test)]
mod tests {
    #[test]
    fn metadata_matches_package() {
        let info = super::app_info();
        assert_eq!(info.name, "PCB RE Studio");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }
}
