// アプリ本体。デスクトップは main.rs から、モバイル（iOS/Android）は mobile_entry_point から呼ぶ。

mod commands;
mod config;
mod keychain;
mod last_uid;
mod lcam_auto;
mod lcam_login;
mod state;
mod upstream;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::SessionState::default())
        .manage(lcam_login::ConnectState::default())
        .setup(|app| {
            tauri::async_runtime::spawn(lcam_auto::run_loop(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::login,
            commands::logout,
            commands::restore_session,
            commands::api_request,
            commands::download_file,
            commands::lcam_connect,
            commands::lcam_auto_get,
            commands::lcam_auto_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
