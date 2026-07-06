// OSキーチェーン(Windows Credential Manager / macOS Keychain / Linux Secret
// Service)への credential / session cookie の保存。永続ログインの要。
// credentialを保存するのは、Worker発行のsession cookieが失効した際に
// ユーザーへ再入力させず自動で再ログインするため。

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const CRED_SERVICE: &str = "com.aitapp.desktop.credential";
const SESSION_SERVICE: &str = "com.aitapp.desktop.session";

// keyringのmacOS実装(set_password)はfind→update/addという内部ロジックだが、
// findが既存アイテムを見つけられない状況でaddに倒れ、実際には存在する
// アイテムとぶつかって重複エラーになることがある。書き込みを直列化した上で
// 毎回delete→setにすることで、findの結果に依存しないようにする。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
pub struct StoredCredential {
    pub id: String,
    pub password: String,
}

pub fn save_credential(uid: &str, password: &str) -> Result<(), String> {
    let entry = Entry::new(CRED_SERVICE, uid).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&StoredCredential {
        id: uid.to_string(),
        password: password.to_string(),
    })
    .map_err(|e| e.to_string())?;
    upsert_password(&entry, &json)
}

fn upsert_password(entry: &Entry, secret: &str) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let _ = entry.delete_credential();
    entry.set_password(secret).map_err(|e| e.to_string())
}

pub fn load_credential(uid: &str) -> Option<StoredCredential> {
    let entry = Entry::new(CRED_SERVICE, uid).ok()?;
    let json = entry.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

pub fn delete_credential(uid: &str) {
    if let Ok(entry) = Entry::new(CRED_SERVICE, uid) {
        let _ = entry.delete_credential();
    }
}

pub fn save_session(uid: &str, cookie: &str) -> Result<(), String> {
    let entry = Entry::new(SESSION_SERVICE, uid).map_err(|e| e.to_string())?;
    upsert_password(&entry, cookie)
}

pub fn load_session(uid: &str) -> Option<String> {
    let entry = Entry::new(SESSION_SERVICE, uid).ok()?;
    entry.get_password().ok()
}

pub fn delete_session(uid: &str) {
    if let Ok(entry) = Entry::new(SESSION_SERVICE, uid) {
        let _ = entry.delete_credential();
    }
}
