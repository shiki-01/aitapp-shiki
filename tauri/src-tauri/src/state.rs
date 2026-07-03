use std::sync::Mutex;

// 現在ログイン中ユーザーのsession cookieをメモリにキャッシュする。
// 起動直後や未ログイン時はNone。ここに無ければkeyring/last_uidから復元する。
pub struct CurrentSession {
    pub uid: String,
    pub cookie: String,
}

#[derive(Default)]
pub struct SessionState(pub Mutex<Option<CurrentSession>>);
