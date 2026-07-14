# aitapp-mcp

`worker/` が提供するREST APIを、Claude Code等のMCPクライアントからツールとして
使えるようにするMCPサーバー。実行形態は2つあり、ツール実装（`src/tools/*`）は共通:

- **stdio（ローカル実行、このディレクトリ）**: `bun run src/index.ts`。
  ダウンロードはローカル一時ファイルへ保存、`filePath` でのアップロードが使える。
- **Streamable HTTP（リモート実行）**: デプロイした worker の `/mcp` エンドポイント
  （`worker/src/mcp/`）。資格情報は worker のシークレット、認証は
  `Authorization: Bearer <MCP_TOKEN>`（ヘッダを設定できないクライアント、
  例えばスマホの Claude アプリのカスタムコネクタ向けには `/mcp/<MCP_TOKEN>` の
  URL 埋め込み方式もある）。セットアップはリポジトリ直下の README を参照。
  **注意: デプロイ版は LCAM が Cloudflare の egress IP を拒否するため `lcam_*` ツールは
  使えない**（Moodle・シラバス系は動く。`MIGRATION_NOTES.md` §13.1）。

以下はstdio（ローカル実行）の説明。

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
| `AITAPP_ID` | ○ | 大学ポータル(LCAM)のログインID |
| `AITAPP_PASSWORD` | ○ | 大学ポータル(LCAM)のログインパスワード |
| `AITAPP_WORKER_URL` | - | `worker/` のベースURL。既定値 `http://localhost:8787` |
| `AITAPP_APP_ORIGIN` | - | `worker/` の `APP_ORIGIN` と一致させるOrigin値。既定値 `http://localhost:5173` |
| `AITAPP_MOODLE_ORIGIN` | - | Moodle接続先ホスト名（例 `cms.aitech.ac.jp`）。未設定ならMoodle系ツールは使えない |
| `AITAPP_MOODLE_ID` | - | Moodle専用ログインID。LCAMとMoodleのアカウントが別の場合のみ設定 |
| `AITAPP_MOODLE_PASSWORD` | - | Moodle専用ログインパスワード。`AITAPP_MOODLE_ID` とセットで指定したときだけ有効（片方だけなら無視され、LCAMのID/パスワードがMoodleにも使われる） |

Moodleへの認証は、ログイン時に一度だけID/パスワードで `login/token.php` から
トークンを取得し、以後はそのトークンだけで動く（失効時のみ保存済み資格情報で
自動再取得）。トークンを直接渡す方式は、失効時に手動での再登録が必要になり
自動再取得が効かなくなるため採用していない。

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
        "AITAPP_PASSWORD": "your-portal-password",
        "AITAPP_MOODLE_ORIGIN": "cms.aitech.ac.jp"
      }
    }
  }
}
```

もしくは `claude mcp add` でユーザースコープに登録する（`.mcp.json`をリポジトリに
置きたくない場合）。

## 提供ツール

ツール名は上流システムごとのプレフィックスで分類している。

- `lcam_*`: LCAM（連絡・時間割・予定・成績・アンケート）
- `moodle_*`: Moodle（課題・クイズ・コースファイル）
- `syllabus_*`: シラバス検索システム

| ツール | 対応するworker API |
|---|---|
| `lcam_list_notices` | `GET /api/notices` |
| `lcam_get_notice_detail` | `GET /api/notices/detail` |
| `lcam_download_notice_attachment` | `GET /api/file/:id`（連絡の添付ファイルのみ対応） |
| `lcam_get_timetable` | `GET /api/timetable` |
| `lcam_get_schedule` | `GET /api/schedule` |
| `lcam_get_grades` | `GET /api/performance` |
| `lcam_list_enquetes` | `GET /api/enquetes` |
| `lcam_get_enquete_questions` | `GET /api/enquetes/questions` |
| `lcam_save_class_enquete_answer_draft` | `POST /api/enquetes/answer`（実書き込み） |
| `lcam_submit_class_enquete_final` | `POST /api/enquetes/submit`（実書き込み・取り消し困難） |
| `moodle_list_courses` | `GET /api/moodle/courses`（受講中コース一覧。quiz/files系が要求するcourseIdの取得起点） |
| `moodle_list_assignments` | `GET /api/assignments` |
| `moodle_get_assignment_submission_status` | `GET /api/moodle/assignment/status`（提出状況＋締切。未提出課題の定期チェック向け） |
| `moodle_save_assignment_draft` | `POST /api/moodle/assignment/draft`（実書き込み） |
| `moodle_upload_assignment_file` | `POST /api/moodle/assignment/upload`（実書き込み） |
| `moodle_submit_assignment` | `POST /api/moodle/assignment/submit`（実書き込み・取り消し不可） |
| `moodle_get_quiz_info` | `GET /api/moodle/quiz/info` |
| `moodle_start_quiz_attempt` | `POST /api/moodle/quiz/start`（実書き込み・試行回数を消費。設問は要約して返す） |
| `moodle_get_quiz_questions_html` | `GET /api/moodle/quiz/questions`（開始済みattemptの設問HTML全文。要約で足りないときのフォールバック） |
| `moodle_answer_quiz_question` | `POST /api/moodle/quiz/answer`（実書き込み） |
| `moodle_finish_quiz_attempt` | `POST /api/moodle/quiz/finish`（実書き込み・取り消し不可） |
| `moodle_get_quiz_attempt_result` | `GET /api/moodle/quiz/result`（確定済みattemptの採点結果） |
| `moodle_get_course_files` | `GET /api/moodle/resources`（コース内「ファイル」リソース一覧） |
| `moodle_download_file` | `GET /api/moodle/file`（Moodle上のファイル・設問中の音声等をダウンロード） |
| `syllabus_get_filters` | `GET /api/syllabus/filters` |
| `syllabus_search` | `GET /api/syllabus/search` |
| `syllabus_get_detail` | `GET /api/syllabus/detail` |

Moodle課題・シラバスには現状ダウンロード可能な添付URLがworker APIから
返されないため、LCAM連絡の添付ダウンロードは`lcam_download_notice_attachment`、
Moodle側（コースファイル・設問中の音声等）は`moodle_download_file`と使い分ける
（`moodle_upload_assignment_file`は逆方向、ローカルファイルをMoodleへアップロードする
書き込みツール）。`moodle_download_file`はMoodleの2種類のファイルURL形式
（`webservice/pluginfile.php`のtoken認証、レガシー`file.php`の都度Webログイン）を
自動判別する。詳細は`MIGRATION_NOTES.md`12.5節を参照。

クイズ・課題提出系のうち`moodle_finish_quiz_attempt`・`moodle_submit_assignment`は取り消し不可の操作で、
`confirm`に専用の文字列（`CONFIRM_FINISH_ATTEMPT` / `CONFIRM_SUBMIT_ASSIGNMENT`）を渡した
場合のみ実行される。詳細・実データ検証状況は`MIGRATION_NOTES.md`の12節を参照
（MIGRATION_NOTES内のツール名は改名前の当時のもの）。

## 認証・再ログインの挙動

- 初回ツール呼び出し時、ローカルキャッシュにsession cookieが無ければ
  `POST /api/auth/login` でログインし、cookieをキャッシュする。
- 呼び出しが401を返したら、キャッシュを破棄して1回だけ再ログインし、
  同じリクエストを1回だけリトライする。それでも失敗したらエラーをそのまま返す。
  直列化・keep-alive・自動復旧は行わない（`worker/`側の再ログイン方針と同じ）。
- MFA導入等でログイン自体が失敗するようになった場合は、エラーが返るだけで
  自動では回復しない。
