# 未確認・未対応・要修正の項目

最終更新: 2026-09-25（スケジュール・アンケート・提出状況の画面反映を追記）。LCAM を本家アプリ方式（`lamyapp://` の key → アプリ用資格情報で透過再ログイン。
`MIGRATION_NOTES.md` §15）に変更した時点の一覧。解消したら、この表から消して、根拠を `MIGRATION_NOTES.md` に残す。

上流（LCAM・Moodle・シラバス）の実観測が要る項目の台帳は、別文書 `docs/VERIFICATION_BACKLOG.md`（2026-07 時点、
コードを変更しない前提の記録）にある。

## 要修正（不具合。今は直さない）

### デスクトップ版で添付ファイルを開くと `opener.open_path not allowed`（修正済み・実機での確認待ち）

- **症状**: デスクトップ版（Tauri）で、学内共有ファイル・レポートの提出履歴・連絡の添付・お知らせの添付を開くと、
  コンソールに `Uncaught (in promise) opener.open_path not allowed. Permissions associated with this command:
  opener:allow-open-path`（`api.desktop.ts` の `openPath(localPath)`）が出て、ファイルが開かない。
- **原因**: `tauri/src-tauri/capabilities/default.json` が `opener:default` だけで、`openPath` に要る `opener:allow-open-path` が無い。
- **修正**（2026-09-25）: `open_path`（OS の既定アプリで開く）はやめ、**既定ブラウザで開く**方式に変更。保存済みのファイルを Rust の
  一時 HTTP サーバ（127.0.0.1・ランダムポート・128bit のトークン付き URL・最大 60 秒/3 回）で配信し、その URL を
  `open_in_browser` コマンド（`tauri/src-tauri/src/browser_open.rs`）が既定ブラウザで開く。PDF・画像・txt は表示、それ以外
  （HTML・SVG・Office 文書）は保存になる。opener の JS 権限は使わない。単体テスト・`cargo check`・型チェックは通過。
- **未確認**: `tauri dev` の実機で、各画面のファイルが既定ブラウザで開くこと。確認できたらこの項目を消す。

### 「不可逆操作を許可」のチェックボックスが Tauri 版で編集できない

- **症状**: 「その他 → Claude 連携」の「不可逆操作を許可（クイズ受験開始・課題/アンケート提出）」を操作できない。
- **原因（コードからの推定。実機での再現は未確認）**:
  - `web/src/lib/views/More.svelte` の `disabled={mcpBusy || mcpWrites === undefined}`（L455 付近）。`mcpWrites` は
    `api.me()` の `mcpWrites` で初期化する（L157-166）。
  - ブラウザ版の `me()`（`GET /api/auth/me`）は `mcp` / `mcpWrites` を返すが、Tauri 版の `me()`
    （`web/src/lib/api.desktop.ts` L53-61）は `restore_session` の `userId` しか返さない。そのため `mcpWrites` が
    `undefined` のままになり、チェックボックスが常に `disabled` になる。`mcpIssued`（MCP の発行済み表示）も同様に取れない。
- **直し方の案**: Tauri 版の `me()` で、`restore_session` のあとに `GET /api/auth/me`（`api_request` 経由）を呼び、
  `mcp` / `mcpWrites` も返す。ブラウザ版で編集できるかも、あわせて確認する。
- Worker 側（`POST /api/auth/mcp-writes`、`state.mcpAllowWrites`）は変更不要のはず。

## 未確認（実機・実データで確認が必要）

| 項目 | 状況 |
|------|------|
| Tauri の `lamyapp://` 傍受（`on_navigation`） | Windows（WebView2）は、ユーザー報告（2026-09-25。`tauri dev` を本番の Worker に向けて登録し、Web と共存して使えた）で動作。**macOS（WKWebView）・iOS は未検証** |
| iOS の WebView 表示（新しいウィンドウが現在の UI を置き換える挙動）、閉じた後にアプリへ戻るか | 未検証（`MIGRATION_NOTES.md` §14.10） |
| key（`lamyapp://…?key=`）の有効期間・使い捨てか | 取得直後の交換は成功。期限は未確認 |
| アプリ用トークン（`spAppLogin/` の `password`）の有効期間 | 未確認。失効すると 424 で再登録を求める設計 |
| `smartPhoneLogin/` の失敗時の実応答 | アプリのコード上は JSON `{status:'fail'}`。実応答は未観測。ログイン直後の SP 時間割の確認で失効を検知した場合は、資格情報の拒否ではなく一時的な上流エラーとして扱う（並行の再ログインとの競合でも起きるため。§17.6） |
| スケジュールの補講の表記 | 休講は実データで確認済み（`【休講】` + 授業 3 行。`MIGRATION_NOTES.md` §16.2）。補講は未観測（`【補講】` の印が付く想定で同じ扱い） |
| 授業アンケートの一覧の語彙（提出状況・状態）、課題の提出状況の画面 | 実データが 0 件のためダミー API でのみ確認。語彙が想定と違うと「未回答」の判定がずれる（`web/src/lib/enquete.ts`） |
| 複数リクエストが同時に失効を検知したときの挙動 | PC 画面 4 並行で実測済み（§17.6）: 互いのセッションを奪い合い、3 本が失効扱いになった。競合の判定が資格情報の削除に繋がる不具合は修正済み（`app-login.ts`）。修正後の再測定（3 ラウンド）: 毎回 2 本前後が 502 になるが、資格情報・セッションは維持され、直列の再実行は全件成功（§17.6）。並行で失敗すること自体は残る |
| PC 版参照機能を relay 経由（本番 Worker）で実行したときの動作 | ローカルの Worker から LCAM への**直続**では全機能を実データで確認済み（§17.6）。relay の複数 Set-Cookie の中継はコード上は問題なし（`set-cookie` を配列のまま返す）だが、実通信は未確認 |
| 学事システムを開く導線（`/api/open/kyoumu`）の Safari・スマホ | 内蔵ブラウザ（Chromium）では履修登録・履修取消・抽選履修登録に着地することを確認。学事システムの Cookie は `SameSite=None; Secure` だが、Safari のサードパーティ Cookie 制限で iframe への保存が拒否されると、着地先がログインエラーになる可能性がある（未検証） |
| `/mcp` の未対応プロトコルバージョンでの 500 の修正（`718a154`）の効果 | 修正・デプロイ済み。**コネクタを再接続して、`wrangler tail` で 500 が出なくなったか確認する** |
| Moodle のローカル認証がいつまで使えるか | 止まると `/api/auth/login` 自体が通らなくなる（`MIGRATION_NOTES.md` §14.4） |
| Entra の「サインインの状態を維持」（約 90 日）が切れたときの再認証 | WebView 内の Microsoft セッションの期限。切れると番号入力が要る（§14.7） |

## 未対応（意図的に実装していない）

- Web 版（ブラウザ）での `lamyapp://` の自動取得: Web ページの JS はカスタムスキームの遷移を捕まえられない。
  手動の貼り付けのみ。スマホのブラウザでは、OS が `lamyapp://` を本家アプリへ渡して key を消費するおそれがある。
- Android 版 Tauri: `keyring` の保存先が無い。wry 0.55.1 は Cookie の無い URL で NPE のおそれ（§14.10）。
- iOS の署名なし IPA: LCAM 連携の変更を含めて、まだ再ビルドしていない（GitHub Actions の手動ワークフロー）。
- 学事システムの「学籍情報の更新・教職履修カルテの登録」を開く導線: 着地先の画面を実ブラウザで確認できていない（個人情報の画面のため、
  確認の操作が自動判定で拒否された）。`/api/open/kyoumu?to=` の許可リストは、確認できた 3 画面（履修登録・履修取消・抽選履修登録）だけ。
- MFA・番号入力の自動化、パスワードでの LCAM ログイン（LCAM 側が拒否する）。
- 並行再ログインの直列化、keep-alive（Cron）、自動復旧（`CLAUDE.md` の制約）。keep-alive は 2026-09-24 に削除した。

## 既知の制限・リスク（許容している）

- **LCAM はユーザーあたり単一セッション**（実測。§15.5）。PC 版ブラウザや公式アプリで LCAM にログインすると Worker のセッションは
  切れ、Worker が再ログインすると他の場所が切れる。ローカルの Worker と本番の Worker の両方に登録すると、互いに切り合う
  （使う環境は 1 つにする）。
- Tauri の接続先の既定は `http://localhost:8787`（ローカルの KV）。本番向けには、ビルド時に `AITAPP_WORKER_BASE_URL` と
  `AITAPP_APP_ORIGIN` を指定する。
- LCAM への到達は relay（Oracle Cloud の VM 1 台）に依存する。停止すると LCAM 系だけが止まる（Moodle・シラバスは影響なし）。
- 静的ファイルの配信の Basic 認証が `admin:admin`（覗き見防止程度）。
- `.mcp.json`（git 管理外）に Moodle のパスワードが平文で入っている。
- `[assets] run_worker_first = true` のため、静的ファイルの取得もすべて Worker のリクエスト（無料枠は 1 日 10 万）に数えられる。
- アプリ用トークンは資格情報と同等。AES-GCM（`CRED_KEY`）で暗号化して KV に保存し、ログ・エラー文言には出さない。
  `CRED_KEY` を変更すると、保存済みの資格情報は復号できなくなる（全員の再登録が要る）。
