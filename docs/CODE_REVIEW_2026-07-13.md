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

---

# 第2弾: 別視点レビュー (Moodle提出フロー / キャッシュ / 視点偵察)

Opus 3体 + Codex による並列解析を Fable が統合。前回同様コード変更・大学サーバーアクセスはしていない。前回のセキュリティ/上流ロジック/mcp・web とは重ならない「不可逆性・鮮度・空白視点」に絞る。

## ① Moodleへの提出フロー — Opus・Codex 2エンジンが一致

### 🔴 最優先(両エンジン一致)

**S1. `start_quiz_attempt` の二重消費(不可逆・自動発火)**
`worker/src/upstream/moodle/token.ts:31-38` の `withMoodleToken` は `op` 全体を再実行する。`worker/src/upstream/moodle/access.ts:321-342` `startQuizAttempt` は**試行回数消費(start)→設問取得(リード)**の順で、後段のリード中に token 失効すると `MoodleTokenError` が伝播して **start ごと再実行→受験機会を2回消費**。`attemptsAllowed=1` なら2回目は空返り＋UpstreamErrorで「開始失敗」と誤認するが実際は唯一の試行が消えている。→ 消費系書き込みをリトライ単位から外し、start後は attemptId 保持で設問取得だけ再試行。

**S2. 「下書き」ツールが `submissiondrafts=0` 課題では即・不可逆な本提出**
`worker/src/upstream/moodle/access.ts:394-460` の `saveAssignTextDraft`/`saveAssignFileSubmission` は課題の `submissiondrafts` 設定を確認しない。MIGRATION_NOTES §12.3 が「新規課題デフォルト `submissiondrafts=0` では upload/draft 時点で即 `submitted`」と実データで確認済み。なのに `mcp/src/tools/assignments.ts` の説明文は「何度でも差し替え可能」と**誤った安全性を保証**。→ 実行前に `mod_assign_get_submission_status` で確認し、`0` なら confirm 要求。最低でも説明文の無条件保証を訂正。

**S3. ファイル提出の多段フローにロールバック/冪等キーなし**
`worker/src/router.ts:467-479`: `itemid発行→upload→start→saveFileSubmission` が直列で、途中失敗時の掃除・照合なし。特にオンラインテキスト＋ファイル両対応課題では、片側 plugindata のみ送ると `dml_write_exception`(MIGRATION_NOTES §12.3)で**ファイル未提出＋既存テキスト提出も破損**しかけ、ユーザーは提出済みと誤認して締切徒過。

### 🟡 中程度(一致)

| 項目 | 内容 | 場所 |
|---|---|---|
| S4 | `start_quiz_attempt` に confirm ガード無し(finish/submitは二層で有効なのに非対称)。S1と重なると二重消費 | `worker/src/router.ts:378-393` |
| S5 | `saveQuizAttempt` が warnings/status を見ず常に `ok:true` → **未保存を成功と誤報告**しfinishで白紙確定 | `worker/src/upstream/moodle/access.ts:348-360` |
| S6 | `acceptsubmissionstatement:'1'` 固定 → 学術誠実性の**宣誓文を見ないまま無条件同意**して最終提出 | `worker/src/upstream/moodle/access.ts:466-475` |
| S7 | final系(finish/submit)に二重実行・結果不明の照合なし → 通信失敗で1回目確定済みなのに再実行し状態不一致 | `worker/src/router.ts:422,492` |
| S8 | mcp client の401リトライがPOST再送。現状Moodle経路は認証MW前段401なので安全だが、**enquete-final(LCAM経路)は提出後にAuthFailedErrorが出うるか要検証**=唯一の二重提出リスク経路 | `mcp/src/client.ts:90-97` |

**不可逆操作×ガード一覧**:

| 操作 | 不可逆 | confirmガード |
|---|---|---|
| クイズ受験確定 finish | ✅ | ✅ 二層 |
| 課題最終提出 submit | ✅ | ✅ 二層(ただし宣誓文S6) |
| アンケート最終提出 | ✅ | ✅ 二層(S8要検証) |
| **クイズ受験開始 start** | ✅ 試行消費 | ❌ **無し**(S1で二重消費) |
| **課題ファイル/テキスト下書き** | `submissiondrafts=0`で✅ | ❌ **無し**(S2) |

## ② キャッシュ問題 — 「取得しすぎ」と「残留しすぎ」の2方向

### 🔴 残留しすぎ(情報残留)

**C1. logout が KV を消さない**
`worker/src/router.ts:174-179` の `/api/auth/logout` は cookie を Max-Age=0 にするだけ。KVの `UserState`(暗号化credential・`moodleToken`・`lcamCookies`)は**TTLなしで無期限残留**。cookie複製を持つ別クライアントはサーバ側失効機構が無いため通過し続ける=実質「ログアウト＝手元cookie削除」でしかない。→ logoutで `USER_KV.delete` を検討。

**C9. 認証必須レスポンスに `Cache-Control: no-store` 無し**
`worker/src/router.ts:521-545,631-660` のファイル配信・全JSON APIともCache-Control未設定。`/api/file` は `<a target=_blank>` でトップレベルGET遷移するため、成績PDF等の認証済み添付や個人データJSONが**ブラウザのディスクキャッシュに残留**。

### 🔴 取得しすぎ(無料枠浪費・レイテンシ)

**C7. Schedule取得が SP セッションを無効化 → 連鎖再ログイン**
`worker/src/router.ts:237-244` の `/api/schedule` は毎回PCログイン(≈4)＋8週×2ループ ≈20 subrequest。かつ大学ポータルは1ユーザー1セッション(§9.4)なので、**PCログインがKVキャッシュ済みのSP cookieを上流で無効化**→次のnotices/timetableが再ログイン(KV write+1)。Scheduleタブと他タブ往復のたびに重い取得＋KV write上乗せ。

### 🟡 整合性・その他

- **C5** `/api/auth/me` のKV非依存化は妥当だが、他の保護API経路は同じ結果整合性窓を持ち、**browser側は401リトライ非搭載**なので login直後の即取得が空/エラーになりうる(Home.svelteは握り潰し空表示)。
- **C8** タブ切替で全ビュー unmount/remount → `$effect` で毎回全再取得。サーバデータのクロスタブキャッシュ無し。
- **C4/C6** 並行lost-update・二重ログインはCLAUDE.mdで直列化スコープ外=許容。定量影響小。
- **KV write見積**: 発火点はlogin/再ログイン/token更新のみでデータ取得は書かない(原則遵守)。個人利用なら1000/日に収まる見込み。

## ③ 偵察役の発掘 — まだ空白の9視点

| # | 視点 | 空白の根拠(実確認) | 優先 |
|---|---|---|---|
| 1 | **テスト網羅性** | `**/*.{test,spec}` が**0件**、CI無し。暗号/署名/失効検知はネット不要で即テスト可能なのに1本も無い | **High** |
| 3 | **無料枠枯渇時の挙動** | `429\|rate\|backoff\|quota` grep **0件**。KV write上限到達時のランタイム挙動が未実装 | **High** |
| 5 | **mid-session 401のリカバリUX** | 起動時`me()`失敗のみ`/login`遷移。**アプリ内401は汎用エラー表示だけで再ログイン導線なし** | Med-High |
| 8 | **MIGRATION_NOTES「要確認」台帳化** | 「要確認/未実装/未検証」が十数箇所散在(失効検知§3.5等、実サーバ未観測のヒューリスティック) | Med-High |
| 4 | **タイムゾーン(新規バグ)** | `worker/src/upstream/lcam/parse.ts:665-680` の年推定 `now=new Date()` が**Worker=UTC基準**。JST早朝/年末に schedule の年・日付が1日/1年ズレうる | Medium |
| 6 | **Tauri(第4未レビュー)** | `tauri.conf.json` の `csp:null`、`keychain.rs` が**生パスワードをOSキーチェーンに保存**、添付一時ファイルの掃除有無 | Medium |
| 2 | **ロギング/エラー透過** | `onError` が `err.message`(上流断片)をクライアント/ログに透過 | Medium |
| 7 | **依存ドリフト** | mcpだけ `typescript^6` / worker・webは `5.9.3` でメジャー分裂。mcp/bun.lock がドリフト疑い | Low-Med |
| 9 | **文字コード** | 上流読取が全て `res.text()`(UTF-8固定)。エラーページShift_JIS(§9.1)で失効誤検知の理論的余地 | Low |

## 第2弾 総括

最も価値が高いのは前回のセキュリティ視点では出なかった**「操作の不可逆性」**。①提出フロー(S1〜S3)は成績・受験機会という取り返しのつかないものを失うタイプで、しかも `saveQuizAttempt` が常に成功を返す(S5)ため失敗が隠蔽される。②キャッシュは「残留」方向が急所(C1 logout非削除 + C9 no-store欠如)。③偵察役が新規バグ(視点4 TZ年ズレ)と最大の空白(テスト0件)を掘り当てた。

**着手順序案**: (1) S5 `saveQuizAttempt` の成否検証 → S1/S2 の不可逆ガード、(2) C1 logout の KV 削除 ＋ C9 no-store、(3) 視点1 の暗号/署名テスト導入。

