#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod keychain;
mod last_uid;
mod state;
mod upstream;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::SessionState::default())
        .invoke_handler(tauri::generate_handler![
            commands::login,
            commands::logout,
            commands::restore_session,
            commands::api_request,
            commands::download_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
