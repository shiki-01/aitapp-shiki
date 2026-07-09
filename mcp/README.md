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
| `save_assignment_draft` | `POST /api/moodle/assignment/draft`（Moodle・実書き込み） |
| `upload_assignment_file` | `POST /api/moodle/assignment/upload`（Moodle・実書き込み） |
| `submit_assignment` | `POST /api/moodle/assignment/submit`（Moodle・実書き込み・取り消し不可） |
| `get_quiz_info` | `GET /api/moodle/quiz/info`（Moodle） |
| `start_quiz_attempt` | `POST /api/moodle/quiz/start`（Moodle・実書き込み・試行回数を消費） |
| `answer_quiz_question` | `POST /api/moodle/quiz/answer`（Moodle・実書き込み） |
| `finish_quiz_attempt` | `POST /api/moodle/quiz/finish`（Moodle・実書き込み・取り消し不可） |
| `get_course_files` | `GET /api/moodle/resources`（Moodleコース内「ファイル」リソース一覧） |
| `download_moodle_file` | `GET /api/moodle/file`（Moodle上のファイル・設問中の音声等をダウンロード） |
| `get_syllabus_filters` | `GET /api/syllabus/filters` |
| `search_syllabus` | `GET /api/syllabus/search` |
| `get_syllabus_detail` | `GET /api/syllabus/detail` |

Moodle課題・シラバスには現状ダウンロード可能な添付URLがworker APIから
返されないため、LCAM連絡の添付ダウンロードは`download_notice_attachment`、
Moodle側（コースファイル・設問中の音声等）は`download_moodle_file`と使い分ける
（`upload_assignment_file`は逆方向、ローカルファイルをMoodleへアップロードする
書き込みツール）。`download_moodle_file`はMoodleの2種類のファイルURL形式
（`webservice/pluginfile.php`のtoken認証、レガシー`file.php`の都度Webログイン）を
自動判別する。詳細は`MIGRATION_NOTES.md`12.5節を参照。

クイズ・課題提出系のうち`finish_quiz_attempt`・`submit_assignment`は取り消し不可の操作で、
`confirm`に専用の文字列（`CONFIRM_FINISH_ATTEMPT` / `CONFIRM_SUBMIT_ASSIGNMENT`）を渡した
場合のみ実行される。詳細・実データ検証状況は`MIGRATION_NOTES.md`の12節を参照。

## 認証・再ログインの挙動

- 初回ツール呼び出し時、ローカルキャッシュにsession cookieが無ければ
  `POST /api/auth/login` でログインし、cookieをキャッシュする。
- 呼び出しが401を返したら、キャッシュを破棄して1回だけ再ログインし、
  同じリクエストを1回だけリトライする。それでも失敗したらエラーをそのまま返す。
  直列化・keep-alive・自動復旧は行わない（`worker/`側の再ログイン方針と同じ）。
- MFA導入等でログイン自体が失敗するようになった場合は、エラーが返るだけで
  自動では回復しない。
