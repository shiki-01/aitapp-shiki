# コードレビュー / 静的解析まとめ (2026-07-13)

Opus 3体 + Codex による並列静的解析を Fable が統合したもの。**この解析時点でコードの変更は一切していない**（指摘のみ）。上流（大学サーバー）へのアクセスも行っていない。

## 検証の限界

- `vendor/aitapp`（移植元 Dart）サブモジュールが未チェックアウトのため、Dart との**直接照合はできていない**。Dart 側との対比はすべて `MIGRATION_NOTES.md` の記述を根拠にしている。移植忠実性を厳密に確認するには `git submodule update --init` が必要。
- LCAM 系は「ローカル未認証検証のみ」で、実データ観測が未了の項目には「要検証」を付す。

---

## 🔴 最優先（複数ソースが一致 = 確度高）

### 1. LCAM 連絡本文の未サニタイズ描画（Stored XSS）

- `web/src/lib/views/Notices.svelte:158` が上流 HTML を `{@html detail.content}` で生描画。
- 「Worker 側で除去済み」というコメントに反し、`worker/src/upstream/lcam/parse.ts:179` `filterContentHtml` は**色スタイルの除去と URL 自動リンク化のみ**で、`<script>` / `<img onerror>` / `on*` 属性を除去しない。
- **影響**: 授業連絡は個々の教員が送信元＝信頼境界が弱い。cookie は HttpOnly で直接窃取は不可だが、同一オリジンから `credentials:'include'` で成績閲覧・**課題/アンケート提出 API** を不正実行可能。
- **派生リスク**: この上流テキストは MCP 経由で LLM にも渡る。confirm 合言葉が description に平文で書かれているため、**プロンプトインジェクションで取り消し不可操作（提出/受験確定）を誘発**できる。
- **推奨**: Worker 側で allowlist サニタイズ、または web 側で `{@html}` をやめてプレーンテキスト化。

### 2. session cookie の有効期限がサーバー側で未強制

- `worker/src/session/cookie.ts:52-85` `verifySession` は HMAC 署名と型しか見ず、`iat` による期限判定が無い。
- `Max-Age=30日` はブラウザ向けヒントに過ぎず、**漏洩 cookie は `SESSION_SECRET` を回すまで無期限に有効**。要件が意図する「30日」すら効いていない。
- **推奨**: `iat` は既に payload にあるので、`Date.now() - iat > 30日` を KV 非依存で判定追加。

### 3. `moodleOrigin` が任意ホスト指定可能（限定的 SSRF）

- `worker/src/router.ts:139` がリクエスト body の `moodleOrigin` を形式チェックのみで受け、`worker/src/upstream/moodle/access.ts:99` が `https://<任意ホスト>/login/token.php` に ID/pass を POST。
- 要件 §4.2 はホスト固定を想定。ユーザー単位可変化（直近コミット）で許可範囲が広がった。
- **推奨**: allowlist（例 `.aitech.ac.jp` サフィックス）化。

### 4. Moodle token 2 回目失効が 500 に化ける

- `worker/src/upstream/moodle/token.ts:31-38` は再取得後の `op(fresh)` を**try で囲まず**呼ぶため、2 回目も `MoodleTokenError` だと `onError` に該当分岐が無く `internal_error(500) + Moodle メッセージ露出`。
- LCAM 側は `401 reauth_required` に寄せているのに**エラー種別が不整合**で、フロントが再認証フローに載せられない。
- **推奨**: 2 回目も try で囲み、再度 token error なら `AuthFailedError` へ変換。または `onError` に分岐追加。

---

## 🟡 中程度

| # | 場所 | 問題 | ソース |
|---|---|---|---|
| 5 | `worker/src/router.ts:663-681`（onError） | 500/502 で `err.message` をクライアントに返し、上流文言・内部詳細が漏洩 | Opus-A・Codex |
| 6 | `worker/src/upstream/lcam/detect.ts:26-31` | `isLoginSuccess` が **fail-open**（エラー要素が無ければ成功）。メンテ/空 HTML で誤ログイン成立。肯定形判定へ。`node-html-parser` の `:nth-child` 対応も要検証 | Opus-A |
| 7 | `mcp/src/session.ts:30` | `session.json` の `chmod 0600` は **Windows で実質 no-op**（ACL 非対応）。当環境は Windows。README 記載の保護が成立しない | Opus-C |
| 8 | quiz/assignment/enquete tools | 取り消し不可操作の confirm 合言葉が description に平文＝LLM 供給で突破可能（#1 派生） | Opus-C・Codex |
| 9 | 上流 `res.text()` 全般 | charset 処理が無く、LCAM が Shift_JIS 等なら**日本語が文字化け**。シラバスは実データ確認済だが LCAM 系は未認証検証のみ | Opus-B（要検証） |
| 10 | `worker/src/upstream/lcam/client.ts:68-72` | 時間割の生存判定が「TOKEN 文字列の有無」前提。時間割ページに TOKEN が無いと**恒常的に壊れる**。実データ未観測 | Opus-B（要検証） |
| 11 | `worker/src/router.ts:198,459` | `count` 上限なし・upload は `arrayBuffer()` で全量メモリ。DoS/無料枠浪費 | Codex |

---

## 🟢 軽微 / リファクタ（要件の「過剰実装禁止」に照らした削減候補含む）

- **デッドコード**: `worker/src/upstream/lcam/access.ts:132-150` `canLoginLcam` はどこからも import されず。実装は `loginLcam`+`isLoginSuccess` 直接検証で、MIGRATION_NOTES §3.2 の記述と乖離 → 削除＋文書更新を推奨。
- **重複**: MCP `client.ts` の 401 リトライ+保存処理が 3 箇所コピー、`json()` ヘルパが各 tools 8 箇所コピー / worker 側も LCAM・syllabus で共通ヘッダ定義が完全重複、`/api/file` と `/api/moodle/file` のヘッダ転写がほぼ同一、moodle/file で復号 2 回。
- **潜在バグ（低）**: `filterContentHtml` が既存 `<a>` 内 URL を二重リンク化し破損マークアップ生成 / `saveQuizAttempt` が実 status を無視し常に `ok:true` / `jSessionId.split('=')[1]` は値に `=` があると切れる / syllabus/parse.ts に到達不能な `?? '?'`。
- **認証情報ハードコード**: `docker-compose.yaml` に DB/Moodle パスワード平文（ローカル検証用だが `.env` 参照化を推奨）。

---

## 📋 要件との乖離（スコープ）

- **Moodle 書き込み系（クイズ回答・課題提出・アンケート）は、REQUIREMENTS.md §9・CLAUDE.md「やらないこと」の外**（Opus-B・Codex 一致）。ただし MIGRATION_NOTES §12 に実機観測ベースの検証記録があり「推測補完」ではない。**実装削除は不要だが、REQUIREMENTS.md 側にスコープ拡大を追記**して整合させるのが妥当。
- CLAUDE.md には `mcp/`・`tauri/` の位置づけ記載が無い。追記推奨。

---

## ✅ 良好と確認された点（誤検出回避のため明記）

- Durable Objects 不使用・KV 1 ユーザー 1 key・credential は AES-GCM 暗号文のみ・鍵分離（CRED_KEY / SESSION_SECRET）・cookie `HttpOnly;Secure;SameSite=Strict`・透過再ログインは「1 回だけ」で直列化なし・`/api/file` はストリーム pipe（バッファリング無し）・CSRF トークン in-memory 完結・Accept-Encoding 非付与 — **いずれも要件どおり**。
- SSRF/traversal ガードは `/api/moodle/file`（origin プレフィックス必須）・`/api/file/:id`（パスプレフィックス必須）で実装済み。MCP/web からの pass-through 値も worker 側で再検証される。
- IV は毎回 `getRandomValues(12)` で再利用なし、AES-GCM の使い方自体は正しい。
- `@html` は Notices 1 箇所のみ（Syllabus/Assignments は全てテキストバインドで自動エスケープ）。

---

## 総括

設計の背骨である「credential と上流状態を Worker に閉じ込める」方針は堅実に守られており、暗号・cookie・KV 集約・ストリーム処理といった**要件の核は全て遵守**されている。一方、リスクは**信頼できない上流コンテンツの取り扱い**に集中している ── ①連絡 HTML の未サニタイズ描画（XSS）→ ②それが LLM に渡り confirm 合言葉を突破、という連鎖が最も危険。次いで cookie 期限の未強制と moodleOrigin の SSRF 面が「守りの穴」。バグ系（#4 のエラー種別化け、#9 文字化け、#10 時間割）は**実認証での実データ観測が未了**なことが根本原因で、静的解析では決着しない。

**着手優先度**:

1. `filterContentHtml` を allowlist サニタイズ化 or プレーンテキスト化
2. `verifySession` に `iat` 期限チェック
3. `moodleOrigin` allowlist 化

の 3 点が費用対効果最大。
