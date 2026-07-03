// OSキーチェーン(Windows Credential Manager / macOS Keychain / Linux Secret
// Service)への credential / session cookie の保存。永続ログインの要。
// credentialを保存するのは、Worker発行のsession cookieが失効した際に
// ユーザーへ再入力させず自動で再ログインするため。

use keyring::Entry;
use serde::{Deserialize, Serialize};

const CRED_SERVICE: &str = "com.aitapp.desktop.credential";
const SESSION_SERVICE: &str = "com.aitapp.desktop.session";

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
    entry.set_password(&json).map_err(|e| e.to_string())
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
    entry.set_password(cookie).map_err(|e| e.to_string())
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
