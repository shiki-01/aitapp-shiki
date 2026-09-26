// ダウンロード済みのファイルを既定ブラウザで開くための、127.0.0.1 の一時 HTTP サーバ。
// Tauri の opener の open_path はファイルを OS の既定アプリで開き（権限も別途要る）、ブラウザとは限らない。
// そこで、ランダムなトークン付きの URL でファイルを配信し、その URL を既定ブラウザに渡す。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// 配信を許す成功回数（ブラウザが先読みで複数回叩くことがあるため）。
const MAX_SERVES: usize = 3;
/// サーバが待ち受ける最大時間。
const SERVER_LIFETIME: Duration = Duration::from_secs(60);
/// 1 接続がリクエスト行を送ってくるまでの猶予。ブラウザは無通信の先行接続を張ることがあるため、接続ごとに切る。
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// OS の乱数から 128bit のトークン（hex 32 文字）を作る。
fn generate_token() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).map_err(|e| format!("failed to generate token: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// ファイル拡張子から Content-Type を決める。
fn content_type_from_ext(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("txt") | Some("csv") => "text/plain; charset=utf-8",
        Some("html") | Some("htm") => "text/html",
        _ => "application/octet-stream",
    }
}

/// ブラウザで表示する（inline）拡張子か。それ以外は保存（attachment）にする。
/// 学内配布の HTML・SVG をローカルのオリジンで実行させないため、これらは inline にしない。
fn should_inline(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("pdf" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "txt")
    )
}

/// パーセントエンコードを戻す（不正なら None）。
fn url_decode(encoded: &str) -> Option<String> {
    urlencoding::decode(encoded).ok().map(|c| c.into_owned())
}

/// リクエスト行を簡易パースし、トークンと要求ファイル名を取り出す。
/// 形式: `GET /{token}/{filename} HTTP/1.1`
fn parse_request_line(line: &str) -> Option<(String, String)> {
    let path = line.split_whitespace().nth(1)?;
    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let token = parts.next()?.to_string();
    let filename = url_decode(parts.next()?)?;
    Some((token, filename))
}

/// 127.0.0.1 に一時 HTTP サーバを立て、ファイルを配信するローカル URL を返す。
/// URL は `/{ランダムトークン}/{ファイル名}`。トークン不一致は 404。最大 60 秒・成功 3 回で終了する。
pub async fn serve_file_once(file_path: PathBuf) -> Result<String, String> {
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?
        .to_string();
    let token = generate_token()?;

    // ポート 0 で OS に空きポートを選ばせる。
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("failed to bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let url = format!("http://127.0.0.1:{}/{}/{}", port, token, urlencoding::encode(&file_name));
    tokio::spawn(serve_loop(listener, token, file_name, file_path));
    Ok(url)
}

/// accept ループ。接続ごとに別タスクで処理し、無通信の先行接続に本来のリクエストを止められないようにする。
async fn serve_loop(listener: TcpListener, token: String, file_name: String, file_path: PathBuf) {
    let served = Arc::new(AtomicUsize::new(0));
    let ctx = Arc::new((token, file_name, file_path));
    let deadline = tokio::time::Instant::now() + SERVER_LIFETIME;
    while served.load(Ordering::SeqCst) < MAX_SERVES {
        let Ok(Ok((socket, _))) = tokio::time::timeout_at(deadline, listener.accept()).await else {
            break;
        };
        let served = served.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if handle_connection(socket, &ctx.0, &ctx.1, &ctx.2).await {
                served.fetch_add(1, Ordering::SeqCst);
            }
        });
    }
}

/// 1 接続を処理する。ファイルを返せたときだけ true。
async fn handle_connection(
    mut socket: TcpStream,
    token: &str,
    file_name: &str,
    file_path: &Path,
) -> bool {
    let mut buf = vec![0u8; 2048];
    let n = match tokio::time::timeout(READ_TIMEOUT, socket.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => return false,
    };
    let request_line = std::str::from_utf8(&buf[..n]).ok().and_then(|s| s.lines().next());
    match request_line.and_then(parse_request_line) {
        Some((t, f)) if t == token && f == file_name => {}
        Some(_) => {
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n").await;
            return false;
        }
        None => {
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n").await;
            return false;
        }
    }
    let Ok(bytes) = tokio::fs::read(file_path).await else {
        let _ = socket
            .write_all(b"HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n")
            .await;
        return false;
    };
    let disposition = if should_inline(file_path) { "inline" } else { "attachment" };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Disposition: {}; filename*=UTF-8''{}\r\n\
         X-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        content_type_from_ext(file_path),
        disposition,
        urlencoding::encode(file_name),
        bytes.len()
    );
    let ok = socket.write_all(head.as_bytes()).await.is_ok() && socket.write_all(&bytes).await.is_ok();
    let _ = socket.shutdown().await;
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_request_line_success() {
        let (token, filename) = parse_request_line("GET /abc123/test.pdf HTTP/1.1").unwrap();
        assert_eq!(token, "abc123");
        assert_eq!(filename, "test.pdf");
    }

    #[test]
    fn parse_request_line_with_encoding() {
        let (_, filename) = parse_request_line("GET /abc123/%E3%83%86%E3%82%B9%E3%83%88%20a.pdf HTTP/1.1").unwrap();
        assert_eq!(filename, "テスト a.pdf");
    }

    #[test]
    fn parse_request_line_invalid() {
        assert!(parse_request_line("GET / HTTP/1.1").is_none());
    }

    #[test]
    fn content_type_by_extension() {
        assert_eq!(content_type_from_ext(Path::new("a.pdf")), "application/pdf");
        assert_eq!(content_type_from_ext(Path::new("a.png")), "image/png");
        assert_eq!(content_type_from_ext(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(content_type_from_ext(Path::new("a.html")), "text/html");
        assert_eq!(content_type_from_ext(Path::new("a.docx")), "application/octet-stream");
        assert_eq!(content_type_from_ext(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn inline_only_for_safe_types() {
        for ok in ["a.pdf", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.txt"] {
            assert!(should_inline(Path::new(ok)), "{ok}");
        }
        for ng in ["a.svg", "a.html", "a.htm", "a.docx", "a.csv", "noext"] {
            assert!(!should_inline(Path::new(ng)), "{ng}");
        }
    }

    #[test]
    fn token_is_128bit_hex_and_unique() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    async fn http_get(port: &str, path: &str) -> String {
        let mut s = TcpStream::connect(format!("127.0.0.1:{port}")).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    // 無通信の先行接続があっても本来のリクエストが返り、トークン不一致は 404、正しい URL はファイルを返す。
    #[tokio::test]
    async fn serves_file_despite_idle_connection() {
        let dir = std::env::temp_dir().join(format!("aitapp-browser-open-{}", generate_token().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("テスト.pdf");
        std::fs::write(&file, b"%PDF-test").unwrap();

        let url = serve_file_once(file).await.unwrap();
        let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
        let (port, path) = rest.split_once('/').unwrap();
        let path = format!("/{path}");

        // ブラウザの先行接続に相当する、何も送らない接続。
        let _idle = TcpStream::connect(format!("127.0.0.1:{port}")).await.unwrap();

        let wrong_token = format!("/{}{}", "0".repeat(32), &path[33..]);
        assert!(http_get(port, &wrong_token).await.starts_with("HTTP/1.1 404"));

        let text = http_get(port, &path).await;
        assert!(text.starts_with("HTTP/1.1 200 OK"), "{text}");
        assert!(text.contains("Content-Type: application/pdf"));
        assert!(text.contains("inline; filename*=UTF-8''"));
        assert!(text.ends_with("%PDF-test"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
