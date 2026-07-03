// 「最後にログインしたuid」だけを保持する非秘匿ファイル。
// keyringはservice+usernameで引くAPIのため、起動直後にどのuidを
// 引けばよいか分かるようこのファイルだけ平文で持つ(値自体に秘密性は無い)。

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("last_uid.txt"))
}

pub fn save(app: &AppHandle, uid: &str) -> Result<(), String> {
    fs::write(file_path(app)?, uid).map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle) -> Option<String> {
    let path = file_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn clear(app: &AppHandle) {
    if let Ok(path) = file_path(app) {
        let _ = fs::remove_file(path);
    }
}
