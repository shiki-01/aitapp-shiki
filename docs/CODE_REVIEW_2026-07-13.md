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

---

# 第3弾: 投資調査6 + 再偵察3 (テスト/無料枠/Tauri/ロギング/TZ・401/依存 + 攻撃者/運用/UX)

Opus 9体を Fable が統合。コード変更・大学サーバーアクセスなし。

## 新規発見の具体バグ

| ID | 内容 | 場所 | 重要度 |
|---|---|---|---|
| N1 | 締切なしMoodle課題(`duedate=0`)が「1970/1/1・期限切れ」と誤表示され、ホーム「これからの課題」から無言で消える | `access.ts:167` + `Home.svelte:70` | 高 |
| N2 | mid-session 401で詰む: 上流失効時 session cookie自体は有効なので「起動時me()失敗→/login」が発動せず、各画面に汎用エラーが出たまま再ログイン導線なし(手動logoutまで回復不能)。MFA破綻時も同じ | `+page.svelte:18` + api.browser.ts | 高 |
| N3 | schedule年推定が `now=new Date()`(Worker=UTC)基準。JST 00:00-08:59は前日扱いで年末年始に年が1年ズレ/切替9時間遅延 | `parse.ts:665` | 中 |
| N4 | 課題説明(`intro`)がUI非表示 / シラバス0件がエラー赤字化 / 時間割の土曜・7限欠落 | 各view | 中 |

## 投資調査6体

- **テスト**: 0件・CI無し。暗号往復・cookie署名/改竄・detect・csrf・parser土台はネット不要で即テスト可。実HTML依存パーサはfixture採取要。`closeKamokuDivs`等は未exportでテスト不可。推奨: worker→Vitest(node)、mcp→bun test。
- **無料枠**: `429/backoff/quota`ハンドリング皆無。KV write発火はlogin/再ログイン/token更新の3点のみ(原則遵守)。急所: `reloginLcam`が差分チェックなしで毎回write＋write先行のため、上流再ログイン成功でもKV write失敗だけで有効リクエストを500で落とす。schedule subreq=`3+2W`(W≥24超過)、quiz startは`MAX_PAGES=50`単独で上限接近。枠超過は可視の汎用500。
- **Tauri(第4未レビュー)**: CSP=null × 未サニタイズ`{@html}` × 任意path/method中継の三重が最大懸念。生パスワードをOSキーチェーン保存、添付一時ファイル掃除なし。良好: パスワードのログ漏れなし、Mutex健全。
- **ロギング/エラー透過**: `onError`が`err.message`をクライアント表示。上流Moodleの`JSON.stringify(data)`全体(access.ts:444)やexception文字列・内部パーサ名がUI/ログに透過。相関ID・構造化ログ・ログレベル全欠如。良好: cookie/token/password直接埋め込みなし。
- **TZ/401/文字コード**: N2・N3上表。文字コードは現経路では無害と確定(正常系UTF-8、Shift_JISエラーページはstatus≠200でパース前throw、detectマーカーはASCIIで生存)。
- **要確認台帳+依存**: 最優先の未検証は A1成績評点(誤表示)・A4アンケート失敗レスポンス未観測(誤送信)・A2 detect実ログインページ未観測。依存はTS5/6分裂は実行時無害・lockドリフト無し(否定的結果)、MCP SDKがExpress5フルスタックを引き込む攻撃面、esbuild0.21.5/cookie0.6.0等dev依存に低〜中候補=要オンライン確認。

## 再偵察3体

- **攻撃者**: 「二層confirm」は実質単層(MCP層とWorker層が同一のLLM供給文字列を判定、MCPがそのまま転送=注入1回で両層突破)。`start`/`draft`は合言葉すら不要な不可逆経路。書き込み制御面は`web/`に無くMCP+LLM単独。悪意ある設問HTML/連絡添付→LLM→不可逆確定のE2E連鎖、全学配布連絡経由なら多学生協調発火→授業評価汚染・受験機会DoS。session cookieは失効不能なwrite用bearer。スクレイピング×機械速度×Cloudflare出口IPで大学検知→アカウント凍結=存続リスク。マルチテナント越境は実経路なし(健全)。
- **運用ライフサイクル**: secretローテーション=全ユーザー同時ロックアウト(鍵バージョン欄なし・dual-key復号なし)。wrangler.tomlにKV idプレースホルダcommit済み＋env分離なしでサイレントにlocalhost化。KVに削除経路もTTLも無く孤児state無期限残留。MFA一斉導入時に破綻を検知する導線なし。CLAUDE.md乖離で将来エージェントが提出機能をスコープ違反と誤判断する火種。
- **表示・UX**: N1・N4に加え、ホームが3API握り潰しで取得失敗と0件が区別不能、Sheet(全モーダル基盤)にフォーカストラップ・スクロールロックなし、エラーに`aria-live`なし、お知らせ検索がロード済み分のみで11件目以降に到達不能。

---

# 第4弾: 別軸の投資調査6 + 再偵察3 (非同期整合/型安全/HTTP/入力fuzzing/ランタイム互換/パースロジック + レジリエンス/プライバシー/DX)

Opus 9体を Fable が統合。コード変更・大学サーバーアクセスなし。今回は「200 OKで中身が異常」系と「単一情報源の欠如」が共通テーマ。

## 新規発見の具体バグ

| ID | 内容 | 場所 | 重要度 |
|---|---|---|---|
| P1 | Moodleが200でHTML(メンテ/WAF/ログインリダイレクト)を返すと`res.json()`がSyntaxError→**502でなく500**(4箇所)。実運用で最も起きやすいトリガ | `moodle/access.ts:60,111,150,442` | 高 |
| P2 | `duedate`欠損で`new Date(NaN).toISOString()`がRangeError→**`/api/assignments`全体が500**(N1の欠損版) | `moodle/access.ts:167` | 高 |
| P3 | pluginfileダウンロードが`?token=`付き＋`redirect:follow`のまま。別ホストへ30xすると**永続tokenが第三者ログ/Refererに漏れうる** | `moodle/access.ts:586` | 高 |
| P4 | ファイルproxyの`content-length`透過 × Workersのgzip自動展開で不整合→**DL破損**の可能性 | `router.ts:543,658` | 中 |
| P5 | シラバス詳細`url`が`startsWith('/')`のみの弱検証。同一ホスト内path/query汚染＋不正文字で500(400で弾けず) | `router.ts:594` + `syllabus/access.ts:103` | 中 |
| P6 | quiz `getAllAttemptQuestions`がvisited管理なしで`nextpage`循環時に設問重複計上 / `木`→`'thurstay'`タイポで木曜欠落の可能性 | `moodle/access.ts:301` / `parse.ts:534` | 低〜中 |

## 投資調査6体

- **intra-request非同期整合**: 単一リクエスト内は逐次await・request-scoped stateで**健全**(floating promise/stream二重消費/KV不整合なし=否定的結果)。残る注意は失効リトライの副作用再実行境界とMoodle系エラー変換の非対称のみ。
- **型安全性・上流形状崩れ耐性**: P1・P2。上流↔worker境界にZod等ランタイム検証が皆無(MCP入力のみZod)。`getUnusedDraftItemId`のitemid欠損で`"undefined"`提出、`canattempt`欠損で受験可否誤表示。良好: HTMLパーサ層は`?? []`ガード徹底でgraceful。
- **HTTPプロトコル**: P3・P4。上流非200を一律502に潰し404/403/429/503の区別喪失。getFileのCookie付きfollow、login 302のSet-Cookie取りこぼし、Range/HEAD非対応、preflight max-age未設定。良好: moodleWebLoginのmanual redirect・ストリームpipe・CORS設定は健全。
- **入力検証fuzzing(全エンドポイント網羅)**: **body経路の注入(CRLF/param汚染/SSRF)はURLSearchParamsのencodeで構造的封殺**(良好な否定的結果)。残る生挿入面はP5。極端値は`count`上限欠如・quiz `answers`無検証・upload無サイズ制限。JSON `null` bodyで400のはずが500。
- **ビルド/ランタイム互換**: クリティカルな非互換なし(workerはNode API不使用でWeb標準のみ、workerd適合性高い=良好)。唯一の共有依存点`getSetCookie()`は3ランタイム対応済みだが未対応時に空配列で無音破綻。`TextDecoder`はutf-8のみで健全(将来Shift_JIS明示デコードはworkerdで落ちる)。FormDataアップロードは要実行確認。
- **ステートフルパース・業務ロジック**: 概ね健全(無限ループ・大量取りこぼしなし、上限ガード/型チェックで歯止め)。P6に加え、連絡詳細ファイルURLの`no`がコンテナ単位でリセットされ複数コンテナ時に番号ズレ、アンケート`dt`順序依存(存在チェックで誤送信は防止・表示はズレうる)、成績subjectヒューリスティックの誤爆(科目名が「前期」等だと欠落)。

## 再偵察3体

- **レジリエンス(非悪意の上流変化)**: **fetchにタイムアウト皆無**(上流遅延でschedule/quizが扇状にsubrequest/CPU上限超過→切断)、**サイレント0件と構造破壊が区別不能**(セレクタ名変更→NotFoundError握り潰し→「連絡0件の健全アカウント」と同一表示で誰も気づけない)、**位置index/魔法数パース(`c===6/7/10`)が1行ずれで空でなく誤データ**(他人の科目名が教員欄に)、壊れHTML補正が上流の"修正"で逆に失効、固定errorcode/Strutsトークン文字列が失効判定の単一障害点、複合経路の部分成功を無音で完成品化(schedule途中週失敗で切り詰め)。
- **プライバシー/データ最小化**: 「中心は綺麗・周縁が漏れる」。**サーバ側KVは本文PIIを保持せず最小化は優秀**(肯定所見)だが、①第三者PII(教員氏名・ふりがな・連絡本文)が最小化・同意なしに外部LLMコンテキストへ ②成績含みの添付がローカル一時領域に掃除なし堆積(＋MCP経由でLLMへ) ③学籍番号(uid)がTauriの正常系stderrに平文出力。書き込みにはconfirmガードがあるのに読み取りPII外部送信は無ゲートの非対称。
- **コントリビュータDX・保守性**: 既知バグの構造的根因を発掘。**1機能追加で最大13ファイルを手動同期**(web/mcp/workerの型が3つの手書きコピーで既に非対称)、router.tsは683行に8個のcopy-paste body検証、401リトライは3重コピー、**confirm合言葉がworker検証とmcpガードで別リテラル重複**(防御強化改修そのものが地雷)、`MoodleTokenError`だけonErrorのroutingから漏れ(#4の根因)。C/D/EはS8/#8/#4/#5の構造要因で、契約型の単一情報源化で一括是正すべき。

## 第4弾 総括(Fableの構造所見)

1. **「200 OKで中身が異常」に今回のバグが集中**: `res.json()`がHTMLで500(P1)、silent 0件が構造破壊を隠蔽(レジリエンス)、位置ずれで誤データ、`duedate`欠損/0で誤判定(P2/N1)。HTTPステータスを信じる設計の穴。
2. **「単一情報源の欠如」がバグの構造根因**: 型3コピー・confirm重複・error taxonomy。個別修正でなく契約集約で複数バグが一括で片付く(DX偵察の中核発見)。
3. **否定的結果が厚く土台は健全**: intra-request整合・body注入封殺・ランタイム互換・KV最小化・ページングは掘った上で健全と確定。
4. **新規具体バグ7件**(P1〜P6, N1〜N4)はいずれも静的に確定。

**第4弾込みの着手優先度**:
1. `res.json()`をtry/catchで502化 ＋ `duedate`を`Number.isFinite`ガード(P1/P2/N1 ── 実運用で最も起きる500と誤表示を除去)
2. pluginfileを`redirect:manual`＋同一origin検証、content-length/gzip整合(P3/P4 ── token漏れ・DL破損)
3. fetch共通タイムアウト ＋ silent0件/構造破壊の分離(レジリエンス)
4. 契約型の単一情報源化(DX構造根因、S8/#4/#5/#8を一括是正)
5. シラバス`url`検証強化(P5)・`thurstay`タイポ(P6)

---

# 第5弾: 1〜4弾の統合と隣接問題(連鎖 / 修正地雷 / 未検査領域)

1〜4弾(36エージェント)を統合し、周辺の別問題を4体で追加探索して Fable が統合。コード変更・大学サーバーアクセスなし。

## 統合: 8つの構造テーマ

- **A. 不可逆書き込みの制御が脆い**: 二層confirmが実は単層 / start・draftは合言葉不要で不可逆 / S1二重消費 / S2下書き即提出 / S5失敗隠蔽 / S6宣誓文無条件同意
- **B. 「200 OKなのに中身が異常」を信じる**: P1 res.json→500 / silent 0件が構造破壊を隠蔽 / 位置indexパース1行ずれ誤データ / N1・P2 duedate
- **C. 情報が残留し失効できない**: C1 logout非KV削除 / session期限なし(失効不能bearer) / no-store欠如 / 添付一時ファイル残存 / secretローテーション全ユーザーロックアウト / KV TTL無し孤児state
- **D. 上流変化への脆さ**: fetchタイムアウト皆無 / 固定errorcode・Struts文字列・固定ラベルが単一障害点 / 壊れHTML補正が上流"修正"で失効 / 部分成功の無音切り詰め
- **E. 単一情報源の欠如=バグの構造根因**: 型3手書きコピー非対称 / confirm合言葉別リテラル重複 / MoodleTokenErrorがonError漏れ / 1機能追加13ファイル同期
- **F. 無料枠・スケール脆弱性**: 429/backoffなし / reloginのwrite先行 / schedule subreq `3+2W` / KV write増幅
- **G. プライバシーは中心綺麗・周縁漏れ**: KV最小化◎ だが第三者PII→外部LLM無同意 / 添付ローカル残存 / uid正常系ログ
- **H. 観測性・運用の空白**: 相関ID・構造化ログ・ログレベル皆無 / エラー透過 / MFA破綻検知導線なし

## 新規の隣接問題(1〜4弾に無し)

| # | 問題 | 重要度 |
|---|---|---|
| W1 | ブラウザ版(Pages)にセキュリティヘッダ機構が完全欠如(`_headers`もCSP metaも無く、`{@html}`XSS #1の多層防御・クリックジャッキング・MIMEスニッフィング対策ゼロ) | 高 |
| B1 | **ビルド/型チェックが一度も実行されていない**(36体すべて静的読解、node_modules未インストール、typecheck 0回)。全指摘の土台が未検証 | 最高 |
| B2 | vendor/aitapp未チェックアウトで「Dartから取る」大原則が一度も検証されていない | 高 |
| B3 | LICENSE完全欠如 / モバイル→SPA移植でPWA・オフライン・manifest・SWが消失した退行 | 中 |
| H1 | `.mcp.json`のポータルパスワード平文(AES-GCM暗号化がMCP経路で相殺) / docker-compose実パスワード平文 / `.gitignore`に`.dev.vars`・`.mcp.json`記載欠落 | 中〜高 |

良好(隣接の否定的結果): git全履歴に実秘密混入なし / 鍵はキーチェーン・wrangler secretに分離 / package.json scripts全て実在 / 死蔵コードは`canLoginLcam`1件のみ / 第2作業ディレクトリは無関係。

## 複合リスク(単体和より危険な5連鎖)

**最重要の洞察: N2(mid-session 401で回復導線なし)が"増幅器"** で、多数の中severity障害を「一時的失敗」から「手動logoutまで詰む恒久障害」へ格上げする。

- **連鎖A**: schedule往復 × relogin write先行 × KV枯渇 × N2 = 使うほど自壊・詰んだら抜けられない(上流健全なのにアプリだけ500で原因不可視)
- **連鎖B**: 注入源(連絡/設問HTML) × 単層confirm × start/draft合言葉なし = LLM単独でユーザー無関与に受験機会・成績破壊
- **連鎖C**: Moodle 200-HTML(P1) × 固定errorcode × 非リトライ × N2 = 一時障害が恒久500に化ける
- **連鎖D**: iat無し × logout非KV削除 × chmod無効(Win) = 取り消し不能なwrite用bearer(被害持続=鍵ローテーションまで無限)
- **連鎖E**: start二重消費(S1) × save常にok(S5) × finish注入 = 失敗が三重に隠蔽され成績だけ白紙確定

## 修正時の地雷(着手前に必読)

- **C1(logout KV削除)は罠**: CLAUDE.md「即時失効スコープ外」に抵触＋me()がKV非依存なので「me成功だが全データ401」=N2詰みを自作。単独導入禁止(me KV依存化＋browser 401導線とセット必須)
- **#3 allowlist**: dev Moodle(`moodle.shiki-01.com`)は`.aitech.ac.jp`外。本番`cms.aitech.ac.jp`と両方入れないとdev全壊。影響面はMCP経路のみ
- **#2 iat検証の一斉ロックアウトは実は軽い**: MCP/Tauriはcredentialで自動復旧、影響はwebのみ。窓=30日でMax-Ageと一致させれば既存cookie挙動不変
- **P1 res.json**: 必ず`UpstreamError(502)`にし`NotFoundError`にしない(新silent-0件を作らない)
- **契約集約**: 13ファイル同時・ロールバック困難。個別バグ修正とテスト導入の後の独立PRに

### 安全な最初の一手トップ5(順序付き)

1. **#4** MoodleTokenErrorをonErrorにルーティング(enabling fix、エラー写像の土台)
2. **C9** no-storeをfile系2本に限定付与(syllabusは公開データなので付けない)
3. **P2+P1** duedateを`Number.isFinite`ガード＋res.jsonをtry→502化
4. **#2** verifySessionにiat検証(窓=30日固定)
5. **#3** moodleOrigin allowlist(cms.aitech.ac.jp＋moodle.shiki-01.com両方)

## 第5弾 総括

全体は**「中心は堅牢・周縁が脆い」**の一貫パターン。個別バグの山は少数の構造根因(①HTTP status/上流形状を信じる ②単一情報源の欠如 ③N2という回復導線の穴 ④write先行/非リトライ)に収束し、**安全な最初の一手トップ5 + N2導線 + confirmのout-of-band化**の少数修正で5連鎖のほとんどが断てる。**ただし全指摘の大前提=「ビルドが通る」(B1)がまだ未検証**なのが最大の空白。

