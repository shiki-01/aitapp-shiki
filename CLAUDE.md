# Claude Code 向け実装指示プロンプト

以下をそのまま Claude Code に渡す。リポジトリには既存の Dart アプリ（`lib/infrastructure/restaccess/` 配下にスクレイピング処理）と、本指示書、`REQUIREMENTS.md` が含まれている前提。

---

## 指示

このリポジトリの既存 Dart アプリ（大学ポータルを非公式スクレイピングで操作する Flutter アプリ）を、Web 版へ移植する。同梱の `REQUIREMENTS.md` が確定要件。要件に従って実装すること。要件に反する判断はしない。判断に迷う点は、要件の「スコープ外/簡略化項目」に倒す（過剰実装をしない）。

### 最初にやること（コードを書く前）

1. `lib/infrastructure/restaccess/` 配下を全て読み、移植元のロジックを把握する。特に以下を精読する。
   - `access_lcan.dart`（LCAM アクセス）
   - `get_lcam_data.dart`（CSRF トークンの取り回し）
   - `lcam_parse.dart`（HTML パース・失効判定に流用できる箇所）
   - `access_moodle.dart`（Moodle token / JSON）
   - `access_syllabus.dart` / `syllabus_parse.dart`
   - `login.dart` / `identity_provider.dart`（認証情報の入力・保持）
2. 各上流エンドポイントの URL・必須ヘッダ・Cookie・CSRF トークンの流れを、Dart 実装から正確に書き出す。**推測で URL やパラメータを補わない。** Dart に書かれた事実のみを移植元とする。
3. 把握した内容を `MIGRATION_NOTES.md` にまとめてから実装に入る。

### 実装の制約（厳守）

- **Cloudflare 有料機能を使わない。** Durable Objects は禁止。状態は Workers KV に持つ。
- **過剰実装をしない。** 並行再ログインの直列化・即時失効・keep-alive ping・自動復旧ロジックは実装しない（要件のスコープ外）。
- 認証情報を browser に渡さない。session cookie は `HttpOnly; Secure; SameSite=Strict`。
- credential は AES-GCM で暗号化し、KV には暗号文のみ置く。鍵は `env.CRED_KEY`。session 署名鍵は `env.SESSION_SECRET`。両者を分離する。
- KV は user 単位で1 key にまとめ、1 read で全状態を取る（key 分割禁止）。
- ブラウザが手動設定できないヘッダ（Cookie/Origin/Sec-Fetch-*/Accept-Encoding）の付与は、すべて Worker 側（fetch）で行う。
- 別途指示がない限りは main ブランチで作業を行うこと。

### 技術スタック（固定）

- proxy: Cloudflare Workers + Hono + TypeScript
- HTML パース: `node-html-parser`
- 暗号化/署名: Web Crypto API（AES-GCM / HMAC-SHA256）
- フロント: SvelteKit（Svelte 5）+ Cloudflare Pages
- パッケージマネージャ: Bun

### ディレクトリ構成

`REQUIREMENTS.md` 第12節の構成に従う。`worker/`（Cloudflare Workers）と `web/`（SvelteKit）を分ける。

### 実装順序

要件の依存関係に沿い、以下の順で進める。各段階でビルド/型チェックが通ることを確認してから次へ進む。

1. `worker/` の雛形・`wrangler.toml`・KV binding 設定・Hono ルーター骨格。
2. `crypto/aes.ts`（AES-GCM 暗号/復号）と `session/cookie.ts`（HMAC 署名 cookie の発行/検証）。単体で動くことを確認。
3. `store/kv.ts`（UserState の read/write）。
4. `html/parser.ts`（node-html-parser ラッパ）。
5. `upstream/lcam/`（access / csrf / parse / detect）。Dart の `access_lcan.dart`・`get_lcam_data.dart`・`lcam_parse.dart` を移植元にする。失効検知 `detect.ts` は HTML の DOM パターン/リダイレクト先で判定する（ステータスコード依存にしない）。
6. `upstream/relogin.ts`（透過再ログイン共通ラッパ）。失効検知→保存済み credential で再ログイン→同一リクエストを**1回だけ**リトライ→再失効でエラー。直列化はしない。
7. `upstream/moodle/access.ts`（token 方式・JSON）。token は KV に保存し password 非依存で永続化。
8. `upstream/syllabus/access.ts` + `parse.ts`（都度 JSESSIONID、状態を持たない）。
9. `router.ts` に `REQUIREMENTS.md` 第9節の API を実装。`/api/auth/login` で credential を即暗号化保存し session cookie を発行。`/api/file/:id` は `Response` body を pipe して stream proxy（バッファリング禁止）。
10. `web/`（SvelteKit）。login 画面と各データ表示画面。fetch は credentials: 'include' で session cookie を送る。

### 各上流の扱い（要点）

- **LCAM**: 透過再ログインの主対象。CSRF トークンは Worker のリクエストハンドラ内で HTML から抽出し次リクエストへ渡す（in-memory 完結、永続化しない）。永続化対象は上流 Cookie のみ。
- **Moodle**: token 保存で password 非依存。透過再ログインのラップ対象外。token 失効時のみ password で再取得。
- **シラバス**: 都度 JSESSIONID 取得。KV に状態を持たない。CSRF 不要。

### MFA / 破綻時の扱い

- 再ログイン2回失敗時は、自動復旧せずエラーを返すのみ。回復は人手で行う前提。
- MFA が将来導入されると透過再ログインは破綻する。検知してエラーを返す分岐だけ用意し、回避策は作らない。

### 確認事項

- Workers KV / Pages の無料枠日次上限は変動する。実装前に Cloudflare 現行ドキュメントで確認し、`MIGRATION_NOTES.md` に控える。
- 上流の URL・パラメータは Dart 実装から取る。不明点は推測で埋めず、`MIGRATION_NOTES.md` に「要確認」として明示する。

### 成果物

- `worker/`（Cloudflare Workers 一式）
- `web/`（SvelteKit SPA 一式）
- `MIGRATION_NOTES.md`（移植元の把握内容・要確認事項・無料枠上限の控え）
- secret の設定手順を含む `README.md`（`wrangler secret put CRED_KEY` 等）

### やらないこと

- Durable Objects の使用。
- 有料機能・有料プラン前提の設計。
- 並行制御の直列化、即時失効、keep-alive、自動復旧。
- Dart 実装に無い URL/パラメータの推測補完。
