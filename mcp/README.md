# aitapp-mcp

`worker/` が提供するREST APIを、Claude Code等のMCPクライアントからツールとして
使えるようにする、ローカル実行専用のMCPサーバー（stdio transport）。

スクレイピング・CSRF・暗号化・透過再ログインのロジックは一切持たない。
`worker/` を呼び出す薄いクライアントであり、`worker/` の認証情報永続化の仕組み
（AES-GCM暗号化してKVへ保存）をそのまま利用する。このMCPサーバー自身が
ローカルに保存するのは **session cookieの値のみ**（`~/.config/aitapp-mcp/session.json`,
権限0600）で、パスワードは保存しない。

## セットアップ

```sh
bun install
```

### 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `AITAPP_ID` | ○ | 大学ポータルのログインID |
| `AITAPP_PASSWORD` | ○ | 大学ポータルのログインパスワード |
| `AITAPP_WORKER_URL` | - | `worker/` のベースURL。既定値 `http://localhost:8787` |
| `AITAPP_APP_ORIGIN` | - | `worker/` の `APP_ORIGIN` と一致させるOrigin値。既定値 `http://localhost:5173` |

`worker/` をデプロイ済みならそのURLを、まだ動作確認中なら `worker/` を
`bun run dev`（`wrangler dev`）で起動してローカルを指す。接続先はこの環境変数
1本で切り替わる。

### Claude Codeへの登録

`.mcp.json`（リポジトリ直下、gitignore対象）を作成する。

```json
{
  "mcpServers": {
    "aitapp": {
      "command": "bun",
      "args": ["run", "mcp/src/index.ts"],
      "env": {
        "AITAPP_WORKER_URL": "http://localhost:8787",
        "AITAPP_APP_ORIGIN": "http://localhost:5173",
        "AITAPP_ID": "your-portal-id",
        "AITAPP_PASSWORD": "your-portal-password"
      }
    }
  }
}
```

もしくは `claude mcp add` でユーザースコープに登録する（`.mcp.json`をリポジトリに
置きたくない場合）。

## 提供ツール

| ツール | 対応するworker API |
|---|---|
| `list_notices` | `GET /api/notices` |
| `get_notice_detail` | `GET /api/notices/detail` |
| `download_notice_attachment` | `GET /api/file/:id`（連絡の添付ファイルのみ対応） |
| `get_timetable` | `GET /api/timetable` |
| `get_schedule` | `GET /api/schedule` |
| `list_assignments` | `GET /api/assignments`（Moodle） |
| `get_syllabus_filters` | `GET /api/syllabus/filters` |
| `search_syllabus` | `GET /api/syllabus/search` |
| `get_syllabus_detail` | `GET /api/syllabus/detail` |

Moodle課題・シラバスには現状ダウンロード可能な添付URLがworker APIから
返されないため、添付ダウンロードはLCAM連絡のみが対象。

## 認証・再ログインの挙動

- 初回ツール呼び出し時、ローカルキャッシュにsession cookieが無ければ
  `POST /api/auth/login` でログインし、cookieをキャッシュする。
- 呼び出しが401を返したら、キャッシュを破棄して1回だけ再ログインし、
  同じリクエストを1回だけリトライする。それでも失敗したらエラーをそのまま返す。
  直列化・keep-alive・自動復旧は行わない（`worker/`側の再ログイン方針と同じ）。
- MFA導入等でログイン自体が失敗するようになった場合は、エラーが返るだけで
  自動では回復しない。
