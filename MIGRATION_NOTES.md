# MIGRATION_NOTES

移植元 Dart 実装（`vendor/aitapp`、GitHub `ROTO0504/aitapp` をサブモジュール化）から把握した事実と、Web 版（`worker/` + `web/`）への移植方針を記録する。**URL・パラメータはすべて Dart 実装由来。推測で補完した箇所は「要確認」と明示する。**

## 0. 移植元の所在

- サブモジュール: `vendor/aitapp`（`https://github.com/ROTO0504/aitapp.git`）
- 主要参照ファイル:
  - `lib/infrastructure/restaccess/access_lcan.dart` — LCAM の全 HTTP アクセス
  - `lib/infrastructure/restaccess/access_moodle.dart` — Moodle token / 課題 JSON
  - `lib/infrastructure/restaccess/access_syllabus.dart` — シラバス HTTP アクセス
  - `lib/domain/features/get_lcam_data.dart` — LCAM 呼び出しフロー（token 取り回し）
  - `lib/domain/features/lcam_parse.dart` — LCAM HTML パース・失効判定
  - `lib/domain/features/get_syllabus.dart` / `syllabus_parse.dart` — シラバスフロー/パース
  - `lib/domain/features/get_moodle_data.dart` — Moodle フロー
  - `lib/application/config/const.dart` — ホスト名・固定ヘッダ
  - `lib/presentation/screens/login.dart` — ログイン UI（`canLoginLcam` で検証）

## 1. ホスト

| 系統 | ホスト | const.dart |
|------|--------|-----------|
| LCAM | `lcam.aitech.ac.jp` | `origin` |
| Moodle | `cms.aitech.ac.jp` | `moodleOrigin`（access_moodle.dart 内） |
| シラバス | `syllabus.aitech.ac.jp` | `syllabusOrigin` |

## 2. 共通ヘッダ（access_lcan.dart 冒頭）

```
constHeader      = { Accept-Language: ja, Connection: keep-alive, Accept-Encoding: gzip, Accept: */* }
secFetchHeader   = { Sec-Fetch-Site: same-origin, Sec-Fetch-Mode: navigate, Sec-Fetch-Dest: document }
contentTypeHeader= { Content-Type: application/x-www-form-urlencoded }
```

- `Cookie` / `Origin` / `Referer` / `Sec-Fetch-*` / `Accept-Encoding` はブラウザが設定できないため、すべて Worker の fetch 側で付与する（CLAUDE.md の制約）。
- **要確認**: `Accept-Encoding: gzip` は Workers fetch では自動でデコードされる。明示指定は無害だが、Worker からの上流 fetch では cf 側が圧縮を制御するため指定しない。

## 3. LCAM（透過再ログインの主対象）

### 3.1 スマホ（SP）ログインフロー — 採用する主経路

> **【2026-09-07 以降は無効】** パスワード直接ログインは Entra SSO + MFA 移行で拒否される。
> 本節の `getCookie` / `loginLcam` / `canLoginLcam` は削除済み。現行方式は §14。

`GetLcamData.create()` 由来:

1. `getCookie()` … `GET https://lcam.aitech.ac.jp/portalv2/sp`
   - レスポンスの `set-cookie` から `JSESSIONID` と `LiveApps-Cookie` を抽出。
   - Dart は `set-cookie` を `split(RegExp(',(?=[^ ])'))` で2分割し `cookies[0]=JSESSIONID, cookies[1]=LiveApps-Cookie` としている。
   - **Workers 注意**: `Response.headers.get('set-cookie')` は複数 set-cookie を1本に結合する。Workers では `headers.getSetCookie()` が使えるため、それで配列取得し JSESSIONID / LiveApps-Cookie を名前で拾う（Dart の位置依存 split より堅牢。位置依存は脆いため名前一致に変更。挙動同等）。
2. `loginLcam(id, password, cookies)` … `POST https://lcam.aitech.ac.jp/portalv2/login/login/smartPhoneLogin`
   - body: `userID, password, selectLocale=ja, mode=sp, userDivision=2, spFlg=1, locale=ja, spAppFlag=1, clientLocationUrl=https://lcam.aitech.ac.jp/`
   - headers に `Origin: https://lcam.aitech.ac.jp`, `Referer: https://lcam.aitech.ac.jp/portalv2/sp`。
   - ログイン後も **手順1の cookies を継続使用**（Dart は login 後に cookie を差し替えていない＝セッション固定方式）。
3. ログイン成否は `LcamParse.isLogin(body)`:
   - `#_errorInformation > ul > li:nth-child(1)` が**空**ならログイン成功。

### 3.2 認証情報の事前検証 — `canLoginLcam`

- `POST https://lcam.aitech.ac.jp/portalv2/login/login/spAppLogin/`
- body: `userId, password`（注: フィールド名は `userId`。smartPhoneLogin の `userID` と大小が違う。Dart 原文ママ）
- レスポンス JSON `{ status: 'success' }` で成功判定。
- login API ではこれで先に検証してから本ログインする。

### 3.3 連絡（notices）— `GetLcamData.getNoticelist`

CSRF（Struts）トークンはリクエスト処理内で HTML から抽出し次リクエストへ渡す（in-memory 完結・永続化しない）。

`isCommon`（学内）/ `!isCommon`（授業）で `noticeType = Common|Class`。

1. `getStrutsToken(cookies, isCommon)` … `GET .../portalv2/smartphone/smartPhoneContactNotice/nextPage/{commonContact|classContact}`
   - Referer: `.../portalv2/smartphone/smartPhoneHome/nextPage/contactNotice`
   - 返却 HTML から `lCamStrutsToken` で token 抽出 → `tempToken`
2. `getNoticeBody(cookies, tempToken, isCommon)` … `POST .../smartphone/smartPhone{Type}Contact/select{Type}ContactList`
   - body: `org.apache.struts.taglib.html.TOKEN=tempToken, unReadFlg=1, listPageNo=1, _screenIdentifier=smartPhone{Type}ContactList, _scrollTop=0`
   - 返却から token 抽出 → `token`
3. `getNoticeBodyNext(cookies, token, count, isCommon)` … `POST .../smartphone/smartPhone{Type}Contact/nextSelect{Type}ContactList`
   - body: 同上で `listPageNo=count`
   - **この返却 body をパースして notice 一覧を得る**（`univNotice`/`classNotice`）。
   - **`listPageNo` はページ番号ではなく「先頭から何件返すか」の累積表示件数**。上流は 1..count の全件をまとめて返す。移植元 `load_noticelist_usecase.dart` は 10,20,30… と件数を増やして毎回全件を取り直し（append しない）、`index` は全件通しの 0..N-1。`goDetail/{index}` もこの通し index を使う。
     - 当初の Web 版実装はこれを「ページ番号 + append」と誤解し、ページごとに index が 0 から振り直されて Svelte の `each_key_duplicate`（`common0` 重複）でリスト描画がクラッシュ→「もっと見る」無反応となった。累積件数 + 置き換え方式に修正済み（worker: `count`、web: `count += STEP` で全件再取得）。
   - 注: Dart 原文の `getNoticeBodyNext` / `getNoticeDetailBody` の headers に `Origin: 'https://origin'`（`$` 欠落のリテラルバグ）がある。Web 版では正しく `https://lcam.aitech.ac.jp` を送る（バグ修正、挙動改善）。

#### パース（lcam_parse.dart）

- 学内一覧 `univNotice`: `#smartPhoneCommonContactList > form:nth-child(4) > div.listItem` の各 `> table > tbody > tr > td:nth-child(1)` のテキストを改行分割。index 0=タイトル(「重要」なら important フラグ)、1=送信者、2=日付。
- 授業一覧 `classNotice`: `#smartPhoneClassContactList > form:nth-child(4) > div.listItem`。テキスト index 2=教科、6=タイトル(「重要」判定)、7=講師、10=補講日。
- 詳細 `univNoticeDetail` / `classNoticeDetail`: `body > form > table > tbody > tr` を走査し「連絡内容/内容」「添付ファイル/ファイル」セクションを状態機械で抽出。本文 HTML は inline color/background-color の style 除去 + URL 自動リンク化。
- 添付ファイル URL 生成（パース時）:
  - 拡張子あり: `/portalv2/common/fileUploadDownload/fileDownLoad2/{encodeURI(name拡張子抜き)}/?EXCLUDE_SET=&prefix=no1&no={i+1}`
  - 拡張子なし: `/portalv2/common/fileUploadDownload/fileDownLoad/?EXCLUDE_SET=&prefix=no1&no={i+1}`
- **node-html-parser には `:nth-child` 等の擬似クラスが無い/不完全**なため、`form:nth-child(4)`・`td:nth-child(1)` は **子要素を手動インデックス**して同等処理する（`html/parser.ts` のヘルパ）。挙動同等。

### 3.4 Struts トークン抽出 `lCamStrutsToken`

候補セレクタ（先勝ち）:
1. `#header > form > div > input`
2. `#smartPhoneCommonContactList > form:nth-child(3) > div:nth-child(1) > input`
3. `#smartPhoneClassContactList > form:nth-child(3) > div:nth-child(1) > input`

最初に見つかった input の `value` を返す。見つからなければデータ取得失敗。
- Web 版では「ログインページが返ってきた（=失効）」場合と「単なるパース失敗」を区別し、前者は `LcamExpiredError` を投げて透過再ログインに繋げる（detect.ts）。

### 3.5 失効検知 `detect.ts`（要確認: 実 HTML 未観測のヒューリスティック）

要件 §8: ステータスコードでなく DOM パターン / リダイレクト先で判定。

採用する保守的シグナル（いずれかで失効とみなす）:
- 返却 HTML に SP ログインフォームの痕跡（`name="userID"` または action に `login/login/smartPhoneLogin` / `preLogin`）が含まれる。
- 期待する Struts トークン input も notice コンテナも存在しない、かつログイン系文字列を含む。

過剰検知による再ログイン多発を避けるため、上記に該当しない限り失効扱いにしない。**実際のログインページ HTML を観測でき次第、シグナルを精緻化すること（要確認）。**

### 3.6 時間割（SP）— `GetLcamData.getClassTimeTable`

- `getClassTimeTableBody(cookies)` … `GET .../portalv2/smartphone/smartPhoneHome/nextPage/timeTable`（token 不要）
- パース `classTimeTable`: `body > form > table > tbody > tr` を走査。i 番目で `day = i~/7`, `period = i%7+1`。`> td > div` のノードテキスト index 0=科目(`[八]`除去)、1=教員(`　他`除去)、2=教室(`八草`除去)。

### 3.7 スケジュール — PC ログインフロー（`GetPCLcamData`）

> **【2026-09-07 以降は無効】** 1〜3（pcGetCookie/preAccess/initLogin）は削除済み。現在は登録済み
> Cookie で PC ホーム（`GET /portalv2/common/generalPurpose/`）から token を得て reload する（実データ未検証。§14.4）。

SP とは別系統。`get_lcam_data.dart` の `GetPCLcamData`:

1. `pcGetCookie()` … `GET .../portalv2/`（set-cookie から JSESSIONID/LiveApps-Cookie）
2. `preAccess(cookie)` … `POST .../portalv2/login/preLogin/preLogin`（body: `mistakeChecker=0, clientLocationUrl=https://lcam.aitech.ac.jp/`）→ 新しい JSESSIONID を set-cookie から取得し差し替え
3. `initLogin(id, password, cookies)` … `POST .../portalv2/login/login/initLogin`（body: `userID, password, selectLocale=ja, authenticMethod=1, mistakeChecker=0, EXCLUDE_SET=`）→ 返却から Struts token 抽出
4. スケジュール取得 `getShedule`: `reload`（`POST .../portalv2/home/home/reload`、body: `TOKEN, _screenIdentifier=home, _screenInfoDisp=, _scrollTop=148`）を呼び、`parse.schedule` でカレンダー抽出 → `getSchedule`（`POST .../portalv2/schedule/scheduleForHome/getSchedule`、body: `_mode=5, EXCLUDE_SET=`）で次週送り、を Dart は **25 回ループ**。
   - パース `schedule`: `table.calendar-body` の `thead th` から日付（`M/D`）、`tbody td div` を `<hr class="schedule_line">`/`<br>` 分割でイベント抽出。

**Web 版の方針（要確認・スコープ判断）**: PC フローは UserState に PC 用 Cookie を持たない設計（要件 §6 の UserState は SP cookies + moodleToken + credential のみ）。そのため `/api/schedule` は **リクエストごとに credential 復号 → PC ログイン → reload ループ** を実行する（ステートレス）。
- Cloudflare 無料プランの **subrequest 上限 = 50/リクエスト**。PC ログイン4 + 25×2(reload+getSchedule)=54 で上限超過するため、**ループ回数を既定 8（env `SCHEDULE_WEEKS` で調整可）に制限**する。これは Dart(25) からの**意図的な縮小**で、プラットフォーム制約由来。週数を増やしたい場合は subrequest 上限と相談。

### 3.8 ファイル取得 — `getFile`

- `GET https://lcam.aitech.ac.jp{fileUrl}`（cookies のみ、Origin/Referer なし、constHeader のみ）。
- Dart `shareFile` は `content-type == 'text/html;charset=utf-8'` を「取得失敗（=ログイン画面が返った）」とみなす。Web 版もこの content-type 判定を失効シグナルに使い、透過再ログイン→1回リトライ→ストリーム返却。
- `/api/file/:id` の `:id` は添付相対 URL を base64url した値。復号後 `/portalv2/common/fileUploadDownload/` 前置を検証（SSRF/オープンプロキシ防止）。

## 4. Moodle（透過再ログインのラップ対象外）

- token 取得 `getToken`: `POST https://cms.aitech.ac.jp/login/token.php`（body: `username, password, service=moodle_mobile_app`）→ JSON `{ token }`。`error` キーがあれば失敗。
- 課題 `getAssignments`: `POST https://cms.aitech.ac.jp/webservice/rest/server.php`（body: `wstoken, wsfunction=mod_assign_get_assignments, moodlewsrestformat=json`）。
  - JSON `courses[].assignments[]` を平坦化。`id, name, intro(description), duedate(秒→ms)` と course の `id, fullname`。
- token は KV に永続化し password 非依存。`exception`/`errorcode=invalidtoken` 検知時のみ credential で token 再取得→KV 更新→1回リトライ。

## 5. シラバス（状態を持たない・CSRF 不要・都度 JSESSIONID）

- セッション取得 `getSyllabusSession`: `GET https://syllabus.aitech.ac.jp/ext_syllabus/`。set-cookie から JSESSIONID（`SyllabusParse.cookie` は `set-cookie` を `,(?=[^ ])` 分割し先頭の `name=value` を返す）。同 body から `filters` を抽出。
  - `filters`: `body > form > table:nth-child(1) > tbody > tr > td > table > tbody > tr` から「年度/フォルダ/校舎区分/時限/曜日/開講学期」の `select > option`（先頭 option=「指定なし」はスキップ）を `表示名→value` map 化。
- 一覧 `getSyllabusListBody`: `POST https://syllabus.aitech.ac.jp/ext_syllabus/syllabusSearch.do`
  - body: `syllabusTitleID=year, indexID=folder|'', subFolderFlag=on, syllabusCampus, syllabusSemester, syllabusWeek, syllabusHour, kamokuName=, editorName=, freeWord=searchWord|'', actionStatus=search, subFolderFlag2=on, bottonType=search`
  - headers: `Origin`, `Referer: .../ext_syllabus/`, `Cookie: JSESSIONID`
  - パース `searchList`: `body > form > table:nth-child(2) > tbody > tr > td > table > tbody > tr`。各行 `td` から texts 抽出。texts[3]=教科, texts[5]=教員, texts[10]=区分, texts[11]=単位数, 詳細URL=`td > a` の `onclick` を `'` split [1]。
  - 0件時、`#errorTag > li` があれば「一致なし」、無ければ取得失敗。
- フィルタ再取得 `refreshFiltersSession`: `POST .../ext_syllabus/syllabusSearch.do;jsessionid={id}`（year に応じてフォルダ等を更新、`actionStatus=titleID, bottonType=titleID`）。
- 詳細 `getSyllabus(detailUrl, jSessionId)`: `GET https://syllabus.aitech.ac.jp{detailUrl}`（Referer: `.../syllabusSearch.do;{jSessionId}`）。
  - パース `detail`: `body > table:nth-child(16) > tbody > tr > td > table > tbody > tr` を `_extractDetailText` で展開し、固定ラベル配列でインデックス化して各項目抽出。
- **Web 版の方針（要確認）**: ステートレスのため `/api/syllabus/*` は毎回 `getSyllabusSession` で新規 JSESSIONID を取得してから検索/詳細を実行する。詳細取得が「同一セッションで検索済みであること」を要求する場合は失敗し得る（実サーバ未検証）。

## 6. アーキテクチャ上の決定（要件準拠）

- 状態は Workers KV の 1 ユーザー 1 key（`user:{id}`）に集約、1 read で全取得（要件 §6）。
- `UserState = { lcamCookies: {jsessionid, liveApps}|null, moodleToken: string|null, credential: {iv, ciphertext} }`。
- credential は AES-GCM 暗号文のみ KV 保存。鍵は `env.CRED_KEY`（SHA-256 で 32byte 鍵に正規化）。
- session cookie は `userId(=愛工大ID)+iat` を `env.SESSION_SECRET` で HMAC-SHA256 署名。属性 `HttpOnly; Secure; SameSite=Strict; Path=/`。
- `CRED_KEY` と `SESSION_SECRET` は別 secret（要件 §10）。
- login/logout は Origin チェック併用（`env.APP_ORIGIN`）。
- 透過再ログイン: 失効検知→credential 再ログイン→**同一処理を1回だけ**リトライ→再失効でエラー。直列化・即時失効・keep-alive・自動復旧は**実装しない**（要件 §11）。
- `/api/file/:id` は `Response.body` をそのまま pipe（バッファリング禁止）。

### 同一サイト要件（SameSite=Strict）

`SameSite=Strict` の session cookie をフロント(`web/`, Pages)→Worker の `fetch(credentials:'include')` で送るには、両者が **同一 registrable domain（eTLD+1）** である必要がある（例: `app.example.com` と `api.example.com`）。デプロイ時は同一ドメイン配下に揃える。ローカルは双方 `localhost`（別ポートは same-site）で成立。

## 7. Cloudflare 無料枠（実装前確認・要再確認）

公式ドキュメントは変動するため、デプロイ前に最新値を確認すること。本実装時点で前提に置いた概算値（**要確認**）:

| 項目 | 概算上限（無料） |
|------|------------------|
| Workers リクエスト | 100,000 / 日 |
| Workers KV 読み取り | 100,000 / 日 |
| Workers KV 書き込み | 1,000 / 日 |
| Workers KV 削除 | 1,000 / 日 |
| Workers KV 保存容量 | 1 GB |
| Worker あたり subrequest | 50 / リクエスト（無料） |
| Pages ビルド | 500 / 月 |

設計上の含意:
- KV 書き込み 1,000/日 を浪費しないよう、書き込みは「ログイン時」「LCAM Cookie 登録時・失効検知時」「moodle token 更新時」と、LCAM データ取得成功時の `lastOkAt` 更新（1 ユーザー 1 時間に最大 1 回。§14）のみ。
- subrequest 50/リクエストの制約から `/api/schedule` のループを縮小（§3.7）。

## 8. Dart 由来でない/推測補完しなかった項目（要確認の総覧）

- 失効検知の具体 DOM パターン（§3.5）— 実ログインページ HTML 未観測。
- シラバス詳細のステートレス取得可否（§5）。
- スケジュールのループ回数（§3.7）— Dart は 25、Web は subrequest 制約で 8 に縮小。
- 上流の各 set-cookie 結合仕様 — Workers の `getSetCookie()` 前提（§3.1）。
- `/login/token.php` の invalidtoken 時 errorcode 文字列 — Moodle 標準の `invalidtoken` を前提（要確認）。

## 9. 実機検証で判明した移植上の落とし穴（確認済み）

ローカル `wrangler dev` + 実サーバーでの動作確認で判明した、Dart→Workers 移植特有の差異。

### 9.1 User-Agent 必須

- Cloudflare Workers の `fetch` は既定で `User-Agent` を送らない。Dart のモバイル http クライアントは UA を送るため、移植時に欠落する。
- **シラバス**: UA 無しだと `/ext_syllabus/` が **HTTP 500**（Shift_JIS の L-Cam エラーページ）。UA を付けると 200。
- **LCAM**: SP（スマホ）系エンドポイントはモバイル UA を前提とし、UA が無いと SP 用コンテナ（`#smartPhoneCommonContactList` 等）やトークンを含まないページが返り、token 抽出失敗・パース0件になる。
- 対応: 全上流リクエストに モバイル Chrome の `User-Agent` を付与（`lcam/access.ts`・`syllabus/access.ts` の `constHeader`）。

### 9.2 `<tbody>` 非補完（node-html-parser vs universal_html）

- 大学の生 HTML には `<tbody>` が存在しない（旧式 server-rendered）。
- Dart の `universal_html` はブラウザ同様に `<tbody>` を自動挿入するため、`table > tbody > tr` 等のセレクタが通っていた。
- `node-html-parser` は `<tbody>` を補完しないため、`tbody` を含むセレクタが全て 0 件になる（連絡一覧/詳細・時間割・シラバスの filters/検索/詳細すべて該当）。
- 対応: `html/parser.ts` に `selAll`/`selOne` を追加し、`tbody` を含むセレクタは「そのまま → tbody 除去版」の順でフォールバックさせる（tbody 有無の両対応）。

### 9.3 parseHtml の script ブロックテキスト設定（重大バグ）

- `parse(html, { blockTextElements: { script: false, style: false } })` と指定すると、
  node-html-parser が `<script>` の中身を HTML として解釈し、スクリプト内の `<` や
  HTML 文字列でツリーが壊れる。結果 `<body>` や後続の `<table>` を丸ごと取りこぼす。
- 時間割ページ（`<table class="jikanwari">`、scriptに renkeiOpen 等の JS）で再現。
  `bodyExists=false` / tables=2（生 HTML は table=3）になっていた。
- 対応: `blockTextElements` をデフォルト相当（`script:true, style:true, noscript:true,
  pre:true`）に戻す。全ページのパース安定性に関わる。

### 9.4 LCAM SP セッションと PC ログインの相互無効化

- 大学ポータルは**ユーザーあたり単一セッション**。`/api/schedule` の PC ログインは
  SP セッション（連絡/時間割）を無効化し、逆も起きる。
- 無効化された SP セッションは「総合ポータルシステム」題の ~720byte スタブを返す
  （ログインフォームではないため `looksLikeLoginPage` では検知できない）。
- 対応: 認証済み SP ページは必ず Struts token フィールドを含むため、それが無い応答を
  セッション喪失とみなし `LcamExpiredError` → 透過再ログインで自動復帰させる。
- SP ログインはセッション ID を rotate するため、ログイン応答の Set-Cookie を取り込み
  保存 Cookie を更新する（これをしないと SP データが一切取れない）。

### 9.5 時間割の実構造

- `<table class="jikanwari">` で、各行 = 曜日 th（rowspan で各曜日初行のみ）+ 時限 th
  （Ⅰ限〜Ⅶ限）+ セル td（`div.kamokuDetailLink`）。
- Dart の連番依存（`i~/7`=曜日, `i%7`=時限）でなく、曜日 th / 時限 th を辿って
  (day, period) を確定する方式に変更（rowspan・空きコマに堅牢）。
- 空きコマのセルは上流が `&nbsp;` で埋める。`nodeText` は当初 `rawText`（未デコード）
  を返していたため、空セルが**リテラル "&nbsp;"** として subject に入り、幽霊
  時間割（タイトル "&nbsp;"）が生成されていた。`nodeText` を `text`（he デコード済み・
  Dart の `node.text` 相当）優先に修正。デコード後の NBSP(` `)は `trim` で
  除去されるため空セルはエントリ化しない。シラバス詳細パースにも同修正が効く。

### 9.6 検証状況

- **シラバス**（認証不要）は実サーバーで session→filters(9行/年度21オプション)→検索(150件)→詳細(24行) までエンドツーエンド動作を確認済み。
- **LCAM**（要認証）はローカル未認証検証のみ。SP ログインページの marker（`name="userID"`+`name="password"`+`smartPhoneLogin`）で失効検知が `true` になることは確認済み。token/一覧/時間割の実データは上記2修正適用後に要再確認。

## 10. 追加スコープ: 成績情報・アンケート一覧（Dart 実装に対応機能なし）

Dart 版アプリの `lib/application/config/const.dart`（`webAccessLinks`）には、アプリ内 WebView
で開くだけでパース未実装のリンク集が定義されている。実アカウントでログインして GET してみたところ、
このうち以下が単純 GET で取得できる実データを返すことを確認したため、新規に worker/mcp へ追加した
（Dart にパース実装は無いため「移植」ではなく実機観測に基づく新規実装）。

### 10.1 成績情報（`/api/performance`、`get_grades`）

- `GET /portalv2/smartphone/smartPhonePerformanceInfor/nextPage/performance/`（cookies のみ、token 不要）。
- デフォルト表示（学年タブ=卒業進級用１年、未修得科目を含めて表示）のみ取得する。
  学年タブ切替（`requirementTypeCode=02/03/04/15`）は `org.apache.struts.taglib.html.TOKEN` 付き
  POST `/smartphone/smartPhonePerformance/selectClassContactList` への遷移が必要だが、
  今回のテストアカウント（1年生）では他学年タブとの差分を実データで確認できなかったため
  実装対象外とした（過剰実装回避。**要確認**: 上級学年アカウントでの実データ）。
- パース: 結果テーブルの各行は `td.txt12` 1個。テキスト行数が1行のみ＝カテゴリ見出し
  （専門教育科目/総合教育科目/【カリキュラム外科目】等）、複数行＝科目データ行として判別する。
  科目データ行は先頭が `※` なら履修中（`inProgress`）、以降の行を
  `教員`/`YYYY年度`/`前期|後期`/`単位 : N`/`評価 : X` のラベルで判定して抽出する
  （固定インデックス依存にせず、ラベルの正規表現マッチで判定＝Dart の位置依存より堅牢）。
- 評価済み科目（`評価 : ` に実際の評点が入るケース）は実データで未観測（テストアカウントは
  全科目履修中のため）。パース処理自体はラベル抽出方式のため対応可能なはずだが**要確認**。

### 10.2 アンケート一覧（`/api/enquetes?type=class|evaluation|campus`、`list_enquetes`）

- `GET /portalv2/smartphone/smartPhoneContactNotice/nextPage/{classEnquete|courseEvaluation|enqueteContact}/`
  （cookies のみ、token 不要。3種とも `smartPhoneHome` のメニューから遷移する別コントローラ）。
  - `class`=授業アンケート（`smartPhoneClassEnqList`）
  - `evaluation`=授業評価アンケート（`smartPhoneCourseEvaluationContact`）
  - `campus`=学内アンケート（`smartPhoneEnqueteContact`）
- デフォルト検索条件（画面初期表示）の一覧のみ取得する。もっと見る（`nextSelect*`）によるページング、
  年度/学期/科目を変えての再検索、および回答送信フロー（`formSubmit`/`showEnqueteContactDetail` 等）は
  書き込み系または過剰実装のため対象外。
- パース: `div.listItem` 内のテキストが「ラベル行 → `:` のみの行 → 値行(複数可)」の繰り返しという
  サイト共通の JSP 出力パターン（連絡詳細パースと同様の慣習）に従うことを利用し、ラベル文字列を
  固定せず「次行が `:`」で汎用的にラベル/値ペアを抽出する（`Record<string,string>` で返す）。
- 実機検証: **授業アンケート(class)のみ実データ1件で確認済み**
  （`授業科目`/`タイトル`/`状態`/`提出期間`/`提出状況` の5ラベルを正しく抽出）。
  授業評価アンケート(evaluation)・学内アンケート(campus)はテストアカウントで該当データが0件のため、
  `div.listItem` の実構造は未観測。同一 JSP パターンだろうという推定に基づく実装であり、
  実データがある状態で再検証が必要（**要確認**）。0件の場合は空配列を返すのみでエラーにはならない。

## 11. 授業アンケート回答（書き込み。一時保存はユーザー許可のもと実データで検証済み）

ユーザーから「授業アンケートへの回答を実装したいが、開発中に実際の課題へテスト送信されるのは困る」
という要望があったため、当初は**読み取り経路のみ実データで検証し、実際の POST（一時保存）は
一度も実行しない**方針で実装した。その後、ユーザーから実際の課題（微分積分1第11回授業の課題）の
添付 PDF を確認した上で一時保存まで実行してよいと明示的な許可を得たため、実際の解答
（ア=2, イ=1, ウ=2。添付 PDF の設問を計算して算出）で `tempSaveAction` を実行し、
`goDetail`→`answer/initialize` を再取得して `value1〜3` が入力値のまま保存されていることを
確認した（**一時保存は実データで動作検証済み**）。以下は実機観測した内容と設計である。

### 11.1 回答画面までの遷移（参照のみ・実機検証済み）

1. `GET smartphone/smartPhoneContactNotice/nextPage/classEnquete/` … 一覧。
   `classenq_student_searchListActionForm`（`detailFormName`）の token を取得。
2. `POST smartphone/smartPhoneClassEnqList/goDetail/{index}`（body: 上記 token,
   `_screenIdentifier=smartPhoneClassEnqList`, `_scrollTop=0`）… 詳細参照画面
   （タイトル・提出期間・設問数・伝達事項等。実データで「授業アンケート参照」画面を確認済み）。
   サーバー側セッションに「選択中のアンケート」が保持される（ID をパラメータで渡す経路が無い）。
3. `GET smartphone/smartPhoneClassEnqAnswer/initialize` … 回答フォーム。
   手順2の直後でないと正しいアンケートの設問が返らない。

### 11.2 設問構造（実データ3問で確認済み）

- 設問は `<dt>ラベル(ア/イ/ウ...)</dt><dd><strong>プロンプト（N文字以内）</strong></dd>` のブロックが
  設問数ぶん並び、対応する回答欄（実データでは全て `<input type="textbox" name="value{i}">`、
  1始まりで dt の出現順と一致）が続く。dt 3個・value1〜3 の順序一致を確認済み。
- テンプレートコメントから、テキストボックス以外に「テキストエリア/日付/コンボボックス/
  ラジオボタン/チェックボックス/添付ファイル」形式が存在することが分かるが、実データが
  無いため HTML 構造は未観測。Web 版はテキストボックス形式の設問のみ回答を受け付け、
  それ以外は `ValidationError` で拒否する（誤った形式で送信しないため。**要確認**）。
- `classEnqId`（隠しフィールド）が回答フォームの実体 ID。

### 11.3 回答保存（実データで検証済み）

- 「一時保存」ボタンの JS (`formSubmit('tempSaveAction')`) から
  `POST smartphone/smartPhoneClassEnqAnswer/tempSaveAction`
  （body: 回答フォーム自身の token, `classEnqId`, `questionNumber=''`, `selectedKey=''`,
  `backPath=''`, `value{i}=回答文字列`）と特定し、実データ（`classEnqId=5167`,
  `value1=2, value2=1, value3=2`）で実行した。直後に `goDetail`→`answer/initialize` を
  再取得し、`value1〜3` の `value=""` 属性が保存した値のまま返ってくることを確認済み
  （**サーバー側に確かに保存されている**）。
- 「確認」ボタン (`formSubmit('confirmAction')`) を経由した最終提出（「提出」相当）のエンドポイントは
  未解明。確認画面の実 HTML を観測していないため、Web 版は一時保存までしか実装していない
  （最終提出の実装は別途、確認画面の実データ観測が必要。**要確認**）。
- 成功/失敗判定は `isLoginSuccess` と同じ規約（`#_errorInformation > ul > li:nth-child(1)` の有無）を
  流用しており、今回の成功ケース（`ok:true`）では正しく機能した。失敗時（バリデーションエラー等）の
  実際のレスポンス文言は未観測のため、エラー時の判定精度は**引き続き要確認**。
- 事故防止のため MCP ツール `save_class_enquete_answer_draft` は `confirm="CONFIRM_SUBMIT"`
  という厳密な文字列を渡したときのみ実際に API を呼ぶガードを入れている（ユーザーの明示的同意なしに
  AI が誤って実行しないようにするため）。
- なお詳細参照画面の JS には `answerCancel()`（`POST smartPhoneClassEnqDetail/answerCancel`、
  確認ダイアログ「提出取消を行いますか？」）があり、提出済み回答は取り消せる模様。
  取消フローも未実装・未検証。

### 11.4 実装バグ2件（開発中に実サーバーで発見・修正）

- **`extractStrutsTokenByForm` の DOM 依存が原因で `LcamExpiredError` を誤検知するバグ**:
  `smartPhoneClassEnqAnswer/initialize` の実 HTML は `<div class="right-module-bold ...">`
  系のラップ div が5個開いて4個しか閉じられておらず（実機観測: 該当 form を単独で
  切り出して再パースしても同じ現象が再現する＝form 自身の内部崩れ）、node-html-parser の
  ツリーが壊れて対象 `<form name="smartphone_smartPhoneClassEnqAnswerActionForm">` 要素自体が
  `querySelectorAll('form')` に出現しなくなる（form 内の `#classEnqId` や `dt`/`input[name=value1]`
  等は個別要素として問題なく拾えるのに、form 要素だけ見えなくなるという非直感的な壊れ方）。
  §9.2/9.3/9.5 と同種の「node-html-parser がタグ閉じ忘れに弱い」問題の新パターン。
  対応: `extractStrutsTokenByForm` を DOM セレクタ方式から、生 HTML 文字列に対する
  正規表現方式（`name="{formName}"` の直後に現れる最初の TOKEN を拾う）に変更した。
- **`submitEnqueteAnswer` が `answer/initialize` を2回叩いていた設計ミス**: 当初は
  `fetchEnqueteQuestions`（内部で1回 GET）で設問を取得した後、token 再取得のためにもう1回
  `getEnqueteAnswerFormBody` を呼んでいた。無駄な subrequest のため、設問と token を
  同じ1回のレスポンスから取り出すよう `submitEnqueteAnswer` を自己完結させた
  （`fetchEnqueteQuestions` は使わず goDetail→answer/initialize を自前で1回だけ辿る）。
  当初はこれが `LcamExpiredError` の原因だと誤って推測したが、実際の原因は上記の
  DOM 崩れによる token 抽出失敗だった（2回叩くこと自体は無関係だったが、
  subrequest 削減のため単一パス化は残した）。

### 11.5 最終提出（確認画面経由の本登録。実データで動作検証済み）

一時保存の実装・検証後、ユーザーが実際に L-Cam 上で「確認」ボタンまで手動操作し、遷移先の
「登録確認」画面の実 HTML を提供してくれた。ただしこれは **PC 版フロー**
（`classenq/student/answerConfirm`、フォーム名 `classenq_student_answerConfirmActionForm`）の
ものであり、本実装が使う **SP フロー**（list→goDetail→answer/initialize の経路）で実際に
返る確認画面はフォーム名・遷移先が異なった。最初の実装はユーザー提供 HTML の PC 版名称で
実装したため実機で `NotFoundError: 登録確認フォームが見つかりません` になり、SP フローを
自前で再現して実際のフォーム名を特定・修正した。最終的に**ユーザーの明示的な許可のもと
実際に最終提出を実行し、成功を確認した**（微分積分の課題、ア=2/イ=1/ウ=2）。

- 「確認」ボタン (`formSubmit('confirmAction')`、回答フォーム自身の
  `smartphone_smartPhoneClassEnqAnswerActionForm` から) は
  `POST smartphone/smartPhoneClassEnqAnswer/confirmAction`
  （body: 回答フォームの token, `classEnqId`, `questionNumber=''`, `selectedKey=''`,
  `backPath=''`, `value{i}=回答文字列`）で、回答値を送信して「登録確認」画面を返す
  （まだ確定しない。届いた回答は読み取り専用テキストとして画面に表示される）。
- **SP フローでの**「登録確認」画面自身は
  `smartphone_smartPhoneClassEnqAnswerConfirmActionForm`
  （action: `/portalv2/smartphone/smartPhoneClassEnqAnswerConfirm/`）という別 form を持ち、
  隠しフィールドとして token・`classEnqId`・`questionNumber=''`・`backPath=''`（空文字。
  PC 版の `/classenq/student/answer/selfForward` とは異なる）を保持する
  （value{i} の入力欄は無い＝回答内容の再送は不要）。
- 画面内の「登録」ボタン (`formSubmit('confirmAction')`、この画面固有の `formSubmit` が
  `smartPhoneClassEnqAnswerConfirm/` 宛にオーバーライドされている) は
  `POST smartphone/smartPhoneClassEnqAnswerConfirm/confirmAction`
  （body: 上記 token/classEnqId/questionNumber/backPath）で、**これが実際の最終登録（本提出）**。
  実行後、一覧（`/api/enquetes?type=class`）の対象が `count:1`→`count:0` に変化したことを確認
  （一覧のデフォルト検索条件が「未提出のみ」であるため、提出済みになった課題が一覧から
  消えたことが成功の裏付けとなる）。
- Web 版はこの3段階（`confirmAction`（回答フォーム）→ 登録確認画面のパース →
  `confirmAction`（`smartPhoneClassEnqAnswerConfirm`、実質的な「登録」実行））を
  `finalizeEnqueteAnswer` として実装し、**実データで動作検証済み**。
- 「登録確認」画面も他のアンケート系画面と同様に共通ヘッダ/ナビ込みの巨大な HTML だが、
  実機観測ではこの画面自体の `<div>` は正しく閉じられており（§11.4 のような崩れは無い）、
  ただし一貫性と堅牢性のため token・classEnqId・backPath の抽出は §11.4 と同じく
  DOM セレクタでなく生 HTML への正規表現で行っている（`parseEnqueteConfirm`）。
- 安全策として、MCP ツール `submit_class_enquete_final` は一時保存用の
  `save_class_enquete_answer_draft` とは別の confirm 文字列（`CONFIRM_FINAL_SUBMIT`）を要求し、
  一時保存で同意を得ていても最終提出には改めての同意が必要という前提を tool description に明記した。
  API 層（`POST /api/enquetes/submit`）でも同じ `confirm` 文字列を必須にし、MCP を介さず
  直接 API を叩かれた場合の保険としている。
- 回答取消 (`answerCancel`) は未実装・未検証。

## 12. Moodle 書き込み系（クイズ回答・課題提出。Dart 実装に対応機能なし）

Dart 版（`access_moodle.dart`）には課題一覧取得（読み取り）しか実装が無く、クイズ回答・
課題提出は Web 版で新規追加した機能。`core_webservice_get_site_info` で利用可能と確認済みの
以下の関数を対象に、Moodle Mobile app 用 Web Service の標準的なパラメータ仕様に従って実装した
（AIT Moodle: `cms.aitech.ac.jp`, Moodle 4.5.12）。

```
mod_assign_start_submission / mod_assign_save_submission / mod_assign_submit_for_grading
mod_quiz_start_attempt / mod_quiz_get_attempt_data / mod_quiz_save_attempt / mod_quiz_process_attempt
mod_quiz_get_quizzes_by_courses / mod_quiz_get_quiz_access_information
core_files_get_unused_draft_itemid / webservice/upload.php (POST multipart, REST APIとは別エンドポイント)
```

### 12.1 `webservice/upload.php` のレスポンス形式（実データで疎通確認済み）

ユーザーの許可のもと、実 credential で以下を実データ確認した（draft area への
テストアップロードのみ。提出・クイズ回答等の書き込みは行っていない）。

- `core_files_get_unused_draft_itemid` のレスポンスは `{component, contextid, userid, filearea, itemid, warnings}`
  というフラットなオブジェクト（`itemid` はトップレベル）。
- `webservice/upload.php` へ `token` / `itemid` / `file_1`（ファイル本体）を multipart/form-data で
  POST すると、HTTP 200 + **配列**（アップロード済みファイル情報のオブジェクトの配列。
  `component, contextid, userid, filearea, filename, filepath, itemid, license, author, source, filesize`）
  が返る。配列であることと `itemid` が送信した値と一致することを確認済み
  （`uploadFileToDraftArea` はこの配列形式を前提に実装）。

### 12.2 実装中に実データで発覚したバグ2件

開発中、`get_quiz_info` / `start_quiz_attempt` の実装を実際の受講科目（courseId=5533、
小テスト8件）に対して動作確認したところ、以下の想定違いが判明し修正した。

- **`mod_quiz_get_quiz_access_information` の `preventaccessreasons` は `{description}` を持つ
  オブジェクトの配列ではなく、そのまま `string[]`**（実レスポンス例:
  `["現在、この小テストは利用できません。"]`）。オブジェクト形式を仮定した初期実装は
  `undefined.description` 相当のバグにはならなかったが値が失われていたため、`string[]`
  前提に修正した。
- **`mod_quiz_start_attempt` は受験不可の場合（時間外・試行回数超過等）、Moodle 標準の
  `exception`/`errorcode` を投げず、HTTP 200 で `attempt: []`（空配列）+ `warnings`
  （`{item, itemid, warningcode, message}` の配列）を返す**。実データ確認: 既に受験期間が
  終了した小テスト（`quizid=39063`、`attemptsAllowed=1`、既存の受験は `state=finished`
  1件のみ）に対して `start_attempt` を呼んだところ `{"attempt":[],"warnings":[{...,"message":
  "現在、この小テストは利用できません。"}]}` が返り、その後 `mod_quiz_get_attempt_data` に
  `attemptid=undefined` を渡す形になって別のエラー（`無効なパラメータ値が検出されました`）を
  誘発していた（`mod_quiz_get_user_attempts` で確認した限り、新規の受験は作成されておらず
  実害は無かった）。`isStartedAttempt`（`attempt` が配列でないことを判定）で明示的に検出し、
  `warnings[0].message` を理由として `UpstreamError` にする形に修正した
  （`worker/src/upstream/moodle/access.ts`）。

### 12.3 実データで完全検証済み（クイズ回答フロー全体）

§12.2 の時点では「受験期間中の実クイズに対して書き込みを行わないと検証できない」ため
未検証としていたが、ユーザーの許可のもと実際に受講中のコース（Communicative English A
2026, courseId=5452, Lesson 12）の6つの小テストを対象に、`start_quiz_attempt` →
`answer_quiz_question` → `finish_quiz_attempt` の一連を実データで検証し、**全問正解
（各クイズとも `mod_quiz_get_user_best_grade` で満点を確認）** した。検証した設問タイプ:

| qtype | 内容 | 検証したクイズ |
|---|---|---|
| `ordering` | 単語の並び替え（D&D方式1） | Vocabulary Quiz 12 |
| `multichoice` | 単一選択 | Vocabulary Quiz 12（音節ストレス）、Emily Part 5a（音声問題） |
| `match` | 文法判定（good/bad、sub-row形式） | Vocabulary Quiz 12 |
| `ddwtos` | 文中の空所への単語ドラッグ（D&D方式2） | Vocabulary Quiz 12、Lesson 12 - Making Questions Shuffle（35問7ページ） |
| `multianswer`(cloze) + 複数`select` | 動画内容理解の穴埋め選択 | Lesson 12 - Animated Short Film Quiz Part 1（YouTube埋め込み動画） |

これにより判明・確定した実装方針:

- `mod_quiz_get_attempt_data` のページング。`page=-1`（全ページ一括取得）は無効
  （§12.2 で発覚）と判断し、`nextpage` が `-1` になるまで `page` を進める実装
  （`getAllAttemptQuestions`）にしたが、これは実際に7ページ・35問のクイズ
  （Making Questions Shuffle）で正しく全問を収集できることを確認済み。
- `mod_quiz_save_attempt` に渡す `answers` の name/value は、`get_attempt_data` が返す
  設問 HTML 中の実際の input/select 要素の name 属性をそのまま使う想定で実装しており、
  これは4種類の qtype（ordering/multichoice/match/ddwtos）全てで実データにより
  正しく動作することを確認した。HTML パース・設問タイプ別のフォーム解析は worker/MCP
  側では行わず、生の HTML を呼び出し元（LLM）に渡す設計のまま（過剰実装をしない）。
- `ddwtos` で同一単語が複数回出現する設問（例: "do" が2箇所）では、Moodle が各タイル末尾に
  `(1)`/`(2)`（または `①`/`②`）のタグを付けて区別する。これを無視して先頭一致で
  選ぶと一部だけ不一致になる（`/Users/x26049xx/Claude/moodle/CLAUDE.md` にある既知の
  落とし穴と同じ）。実データ検証（Making Questions Shuffle 内に実際にこのケースが
  1問あった）で、タグ番号昇順に出現順で割り当てる方式が正しく機能することを確認済み。
  この組み立てロジックはツール側には実装せず、`answer_quiz_question` の description で
  注意喚起するに留めている（判断はLLM側で行う設計）。
- `mod_quiz_process_attempt`（`finish_quiz_attempt`）は `data`（回答）を渡さず
  `finishattempt=1` のみで呼ぶ実装で、事前の `mod_quiz_save_attempt` で保存済みの回答が
  正しく確定されることを確認済み（`mod_quiz_get_user_best_grade` で採点結果を確認）。
- `mod_assign_save_submission` のオンラインテキスト提出・ファイル提出、
  `mod_assign_submit_for_grading`（`submit_assignment`）は、本番 `cms.aitech.ac.jp` では
  元に戻せない記録が残るため検証範囲外としていたが、書き込みを自由に試せるサンドボックス
  （`moodle.shiki-01.com`、Bitnami Moodle 5.0.1、コース `TEST-ASSIGN-001` / 課題
  `テスト課題1`）を用意し、`save_assignment_draft` → `upload_assignment_file` →
  `submit_assignment` の一連を実データで検証した。
  - **コードのバグを発見・修正**: `worker/src/upstream/moodle/access.ts` の
    `saveAssignFileSubmission` が `mod_assign_save_submission` に渡すパラメータキーが
    `plugindata[assignsubmission_file_filemanager]` になっていたが、Moodle の
    `assignsubmission_file` プラグインの外部パラメータ定義上、正しいキーは
    `plugindata[files_filemanager]`（`assignsubmission_file_` プレフィックスなし）。
    誤ったキーだと `invalid_parameter_exception`
    （`Unexpected keys (assignsubmission_file_filemanager) detected in parameter array.`）
    になり `upload_assignment_file` が必ず失敗する状態だった。`files_filemanager` に修正し、
    サンドボックスで疎通確認済み。
  - オンラインテキストとファイルの両方の提出タイプを同時に有効にした課題で、片方のみの
    `plugindata` を渡して `mod_assign_save_submission` を呼ぶと、もう一方の提出プラグイン
    （既に提出データがある場合）が `NULL` で上書きされようとして
    `dml_write_exception`（`Column 'onlineformat' cannot be null`）になることを確認した。
    Moodle 側の挙動であり worker 側では対処していない。1回の呼び出しで有効な提出タイプ
    それぞれの `plugindata` を揃える必要がある（本ツールは file 提出のみを対象にしており、
    online text は `save_assignment_draft` で別途扱う設計のため、両方を同時に有効にした
    課題への提出は現状想定していない）。
  - 課題の「提出前の下書きを許可する」（`submissiondrafts`）設定が `0`（オフ、Moodle の
    新規課題作成時のデフォルト）の場合、`upload_assignment_file` / `save_assignment_draft`
    の時点で提出ステータスが即 `submitted` になり、その後の `submit_assignment`
    （`mod_assign_submit_for_grading`）は「対象なし」で
    `couldnotsubmitforgrading` 警告を返して何もしない。`submissiondrafts=1`
    （下書きを許可する設定）の課題でのみ、`submit_assignment` が意味のある
    `draft → submitted` の状態遷移を行うことを確認した。本番 `cms.aitech.ac.jp` の
    実課題がどちらの設定かは課題ごとに異なるため、`submit_assignment` 呼び出し前に
    現在のステータスを確認できるとよい（→ §12.10 の
    `moodle_get_assignment_submission_status` として後日実装済み）。
  - 上記を踏まえ `submissiondrafts=1` のテスト課題で `save_assignment_draft`
    （オンラインテキスト）→ 別課題で `upload_assignment_file`（ファイル、`files_filemanager`
    修正後）→ `submit_assignment` の一連が正常に完了し、`mod_assign_get_submission_status`
    で `status: "submitted"` になることを確認済み。

### 12.4 安全設計

`finish_quiz_attempt` と `submit_assignment` は取り消し不可のため、一時保存系
（`answer_quiz_question` / `save_assignment_draft` / `upload_assignment_file`）とは
別ツールに分離し、§11.5 の `submit_class_enquete_final` と同じパターンで
`confirm` に専用の文字列（それぞれ `CONFIRM_FINISH_ATTEMPT` / `CONFIRM_SUBMIT_ASSIGNMENT`）
を要求する。MCP ツール層・API 層（`POST /api/moodle/quiz/finish` /
`POST /api/moodle/assignment/submit`）の両方でチェックする多層防御も同様に踏襲した。
`start_quiz_attempt` はツール定義に含まれていないため confirm は要求していないが、
呼び出し自体が試行回数を消費する（取り消し不可）ことを tool description に明記した。

### 12.5 設問・課題が参照する補助ファイルのダウンロード（webservice以外の手段）

課題やクイズには「別途配布されたファイル（例: 単語帳）の内容を踏まえて解答する」形式や、
設問中に音声・動画が埋め込まれる形式がある。これらのファイル取得は
`mod_assign_*` / `mod_quiz_*` の webservice 関数だけでは完結しないため、実データで
以下の2種類のURL形式・認証方式を確認し、両対応する `downloadMoodleFile`
（`worker/src/upstream/moodle/access.ts`）を実装した。

- **`webservice/pluginfile.php/...` 形式**（`mod_resource_get_resources_by_courses` 等の
  webservice関数が返す `fileurl`。正規のファイルピッカー経由でアップロードされたファイルは
  基本的にこちら）: クエリに `?token=<wstoken>` を付与するだけで認証完了する
  （mobile app と同じ方式）。実データ確認: `core_files_get_unused_draft_itemid` /
  `webservice/upload.php` と同様、course の「ファイル」リソース（Vocabulary Card,
  `mod_resource_get_resources_by_courses` で取得）のダウンロードで確認済み。
  **逆に、このURL形式に webservice token を付けずセッションCookieのみでアクセスすると
  `{"errorcode":"missingparam"}` になり、token 必須であることも確認済み。**
- **`file.php/...` 形式（レガシー形式）**: 設問HTML中に教員が直接埋め込んだ音声ファイル
  （例: Emily シリーズの `https://cms.aitech.ac.jp/file.php/5452/Emily/Em-02-06-s.mp3`）
  はこちらの形式で、**`?token=` を付けても既存のCookie無しでも 303 でログイン画面へ
  リダイレクトされ、webservice token では認証できない**ことを実データで確認した
  （`file.php` は通常のMoodle Webログインセッション、Cookie名
  `MoodleSessionAITECH2012` を要求する）。このため `downloadMoodleFile` は
  このURL形式の場合のみ `moodleWebLogin`（`/login/index.php` へ都度ユーザー名/
  パスワードでログインしCookieを取得、永続化はしない）にフォールバックする実装にした。
  同じ理由でこの用途にのみ、通常のMoodle Webログインフォーム（`logintoken`
  CSRF値の取得→POST）を移植先未実装のまま新規実装している
  （LCAM/シラバスのログインとは別の第3の認証経路）。
- 上記2方式の判定はURLのprefix（`{moodle}/webservice/pluginfile.php/`で始まるか）のみで
  行っている。それ以外の内部URL形式（旧 `pluginfile.php`（webserviceプレフィックス無し）等）
  が実際に出現するケースは未確認だが、`file.php` と同じくCookie認証が必要と推測されるため
  同じフォールバック経路（`moodleWebLogin`）で扱う設計にしている。
- 上記2方式とも `GET /api/moodle/file?url=` （`worker/src/router.ts`）でstream proxyし、
  MCP側の `download_moodle_file` ツールからローカル一時ディレクトリへ保存できる。
  SSRF対策として `url` はそのユーザーの `moodleOrigin`（§12.7参照）配下のみ許可している。
  コース内の「ファイル」リソース一覧取得には `mod_resource_get_resources_by_courses`
  を使う `get_course_files` ツール（`GET /api/moodle/resources?courseId=`）を別途追加した。
- 動画（Animated Short Film Quiz 等）は Moodle 上のファイルではなく YouTube 埋め込み
  （`<iframe src="https://www.youtube.com/embed/...">`）のため、上記のダウンロード機構の
  対象外。動画の視聴・内容理解はMCPツールの範囲外とし、呼び出し元（LLM）が別途
  対応する前提とした（過剰実装をしない）。

### 12.6 参考にした外部知見

`/Users/x26049xx/Claude/moodle/CLAUDE.md`（このリポジトリ外、別プロジェクトの
Claude in Chrome を使った同一Moodleサイトの解答自動化に関する知見ドキュメント）を
参考に、設問タイプ（ordering/ddwtos/match等）の想定・重複タイルの扱い・
`file.php`のCookie認証必須という制約を事前に把握した上で実データ検証を行った。
本実装（worker/MCP）はこのドキュメントが前提とする Claude in Chrome ブラウザ操作には
依存せず、Moodle webservice（token方式）とこの節で追加した最小限の非webservice手段
（`webservice/pluginfile.php`のtoken付与、`file.php`向けの都度Webログイン）のみで
同等のクイズ回答・課題提出操作が完結する。

### 12.7 Moodle 接続先ホストのユーザー単位化（TEMP定数の解消）

§12.3 のサンドボックス検証は `worker/src/upstream/moodle/access.ts` の
`MOODLE_ORIGIN = 'moodle.shiki-01.com'`（`// TEMP: sandbox testing` コメント付き）で
本番ホスト `cms.aitech.ac.jp` を一時的に上書きして行っていた。検証完了後、この
ハードコード定数を撤廃し、Moodle 接続先ホストをログイン資格情報の一部
（`Credential.moodleOrigin`）にする設計に変更した。

- `POST /api/auth/login` のリクエストボディに任意項目 `moodleOrigin` を追加。
  LCAM ログイン（`lcam.aitech.ac.jp` 固定、変更なし）は今まで通り必須・独立。
  Moodle token 取得は `moodleOrigin` が空なら丸ごとスキップする best-effort のまま
  （LCAM ログインは Moodle 側の成否に関わらず成立する、既存の挙動を維持）。
- `moodleOrigin` はホスト名として妥当な形式（スキーム・パス・`@`を含まない）かを
  ログイン境界でのみ正規表現検証する。それ以外は特別なSSRF対策はしていない
  （worker が自分の資格情報の送信先をユーザー自身が指定する設計として許容）。
  ただし `GET /api/moodle/file` のオープンプロキシ対策（許可URLプレフィックス）は
  引き続き必要なため、モジュール定数ではなくそのユーザーの `cred.moodleOrigin` を
  参照するように変更した。
- ローカル開発時は `worker/.dev.vars`（gitignore 済み）の
  `MOODLE_ORIGIN_OVERRIDE=moodle.shiki-01.com` が、クライアントが送ってきた
  `moodleOrigin` より常に優先される。本番の `wrangler.toml` にはこの変数を置かないため、
  本番では常にクライアント指定の値がそのまま使われる。`.mcp.json` の
  `AITAPP_MOODLE_ORIGIN` はあえて本番ホスト `cms.aitech.ac.jp` のままにしてあり、
  ローカル `wrangler dev` 実行時にサーバー側の `MOODLE_ORIGIN_OVERRIDE` だけで
  サンドボックスへ強制的に向くことを確認済み。
- 既存の KV 上の `UserState`（`moodleOrigin` 未設定の credential）を持つユーザーは、
  再ログインするまで Moodle 系エンドポイントで
  「Moodle origin not configured for this user」エラーになる。個人開発規模のため
  再ログインで解決する前提とし、マイグレーション処理は用意していない。
- `access.ts` 側は `BASE`/`MOODLE_ORIGIN` のモジュール定数を廃止し、
  `moodleBase(origin)` ヘルパー＋全関数に `origin: string` 引数を追加する形に変更した
  （`downloadMoodleFile` のみ、既に受け取っている `credential.moodleOrigin` から
  自己完結で origin を得られるためシグネチャ変更なし）。

### 12.8 サンドボックス（moodle.shiki-01.com）での全9設問タイプ実地検証と環境構築メモ

サンドボックス（Oracle Cloud 上の Bitnami Moodle、コース `test` courseId=2 の
9問クイズ）で、`get_quiz_info` → `start_quiz_attempt` → `answer_quiz_question`
（全9問を1回の呼び出しで一括保存）→ `finish_quiz_attempt` の一連を実行し、
**自動採点対象の8問すべて正解（mark 1.00）、essay は「要評定」**
（`mod_quiz_get_attempt_review` で確認）となることを検証した。§12.3 で未検証だった
qtype を含む全パターン: `multichoice`（単一選択/複数選択）、`gapselect`、
`shortanswer`、`ordering`、`match`、`ddimageortext`、`ddwtos`、`essay`。

- `mod_quiz_save_attempt` の `answers` には、各設問の `qX:N_:sequencecheck`
  （HTML中の hidden input、value=1）も含めて渡す必要がある。worker/MCP は
  answers をそのまま透過する設計（自動補完しない）なので、呼び出し元（LLM）が
  HTML から拾って含めること。
- `ddimageortext` はドロップゾーンの座標・正解対応が設問 HTML に含まれない
  （AMD JS が別途取得する）。place番号→choice番号の対応は HTML からは判別できない
  ため、正確に解くには背景画像の目視かあてずっぽうになる。今回はサンドボックスの
  DB（`mdl_qtype_ddimageortext_drops`/`_drags`）で正解対応を確認して回答した。
- `ordering` の回答は `qX:N_response_M` に `ordering_item_<md5>` の
  カンマ区切りを並べ替え後の順で渡す（HTML の `<li>` id をそのまま利用）。

**`webservice/rest/server.php` が常に 403 を返した問題の根本原因と修正**（前回
セッションからの持ち越し。Cloudflare/Tunnel/Apache は全て無罪だった）:

1. `webserviceprotocols` が未設定（有効なプロトコルが1つもない状態）だった
   → `php admin/cli/cfg.php --name=webserviceprotocols --set=rest`
2. `enablemobilewebservice=0` だった（`mdl_external_services` の行は enabled=1 で
   不整合。`login/token.php` でのトークン発行だけは通るのが紛らわしい）
   → `--name=enablemobilewebservice --set=1`
3. どのロールにも `webservice/rest:use` capability がなかった（管理UIから
   モバイルサービスを有効化すると自動付与されるが、CLI 設定では付与されない）
   → 認証済みユーザーロール(id=7)に `assign_capability()` で付与

なお `docker exec`（root）で Moodle CLI を実行すると moodledata 内に root 所有の
キャッシュができ `invalid_dataroot_permissions` になる。`docker exec -u daemon` で
実行するか、実行後に `chown -R daemon:daemon /bitnami/moodledata` すること。

**サンドボックス運用メモ**:

- 外部公開は Cloudflare Tunnel `moodle-tunnel-v2`（ID `9b4e9125-…`）。Oracle 側で
  `cloudflare/cloudflared:latest` コンテナ（`--network host`、
  `/home/ubuntu/cloudflared` に config.yml と credentials JSON、ingress は
  `moodle.shiki-01.com → http://localhost:8080`）として稼働。credentials JSON は
  コンテナ内の非rootユーザーが読める必要がある（600 だと permission denied）。
- ホストの 443 は sshd が使用している（外部ネットワークのポート22ブロック対策）。
  そのため moodle コンテナの compose から `443:8443`・`80:8080` の
  ホストバインドを削除した（トンネル経由は 8080 のみで足りる）。443 バインドが
  残っていると sshd と衝突して moodle-app が起動できない。
- 作業ネットワークによっては外向きポート22が全遮断される（`~/.ssh/config` の
  github.com → ssh.github.com:443 と同じ事情）。SSH 不通のときはまず
  これを疑う（インスタンス停止と誤診しやすい）。
- ローカル検証時、過去の `wrangler dev` プロセスが 8787 を掴んだまま残っていると
  新しいプロセスが 8788 に逃げ、`.dev.vars` 変更（`MOODLE_ORIGIN_OVERRIDE` 等）が
  反映されていない旧プロセスが応答し続ける。検証前に 8787 の残骸を kill すること。

### 12.9 Moodle 専用資格情報の分離（LCAM とアカウントが別の場合）

§12.7 までは LCAM と Moodle が同一 ID/パスワードを共有する前提だったが、別アカウント
運用（サンドボックス等）に対応するため、ログインに任意項目 `moodleId` /
`moodlePassword` を追加した。**両方が非空のときだけ** Moodle のトークン取得
（初回・失効時の再取得とも）に使い、揃っていなければ従来どおり LCAM の
id/password を Moodle にも使う（後方互換。既存 KV credential は optional 扱いで
そのまま動く）。MCP 側は `AITAPP_MOODLE_ID` / `AITAPP_MOODLE_PASSWORD` で渡す。

「ID/パスワードではなくトークンを直接渡す」案は不採用とした。トークンは KV に
キャッシュされ `login/token.php` はログイン時と失効時しか呼ばれないため効率面の
得はほぼなく、一方でトークン直渡しは失効時に `withMoodleToken` の自動再取得が
効かなくなり手動再登録が必要になるため。

検証: サンドボックスに LCAM とは別パスワードのユーザー `mcptest` を作成し、
`id=x26049xx`（LCAM）+ `moodleId=mcptest` でログイン → `moodle:true`、発行された
トークンが mcptest のものであること（`mdl_external_tokens`）、そのトークンで
`/api/moodle/quiz/info` が通ること、`moodleId` 未指定の従来ログインも引き続き
動くことを確認済み。

### 12.10 課題の提出状況確認（`mod_assign_get_submission_status`・参照のみ）

2026-07-14 実装。「未提出の課題があるか・期日はいつか」の定期チェック用に、
`GET /api/moodle/assignment/status` と MCP ツール
`moodle_get_assignment_submission_status` を追加した。

- 一覧は既存の `mod_assign_get_assignments`（常に1コール）を流用し、
  `cutoffdate`（提出受付終了）を `cutoffDate` として返すようにした（`duedate` 超過後も
  `cutoffdate` までは遅延提出できるため、実質的な最終期限は両者の遅い方）。
- 提出状況は `mod_assign_get_submission_status`（`assignid` 指定・1件1 subrequest）。
  応答の `lastattempt.submission.status`（チーム提出課題は `teamsubmission`）が
  `submitted` / `new` / `draft` / `reopened`。`gradingstatus`・`timemodified` も返す。
  本番 `cms.aitech.ac.jp`（実データ・読み取りのみ）で応答形状を確認済み。
  `submitted` 以外の値はサンドボックス §12.3 の `draft → submitted` 遷移検証で確認済み。
- subrequest 上限対策はクイズ受験可否（`MAX_ACCESS_INFO_LOOKUPS`）と同じパターン:
  filter（`assignmentId` / `courseId` / `nameFilter` / `dueWithinDays` /
  `includePastDue`）適用後の件数が `MAX_SUBMISSION_STATUS_LOOKUPS`（20）以下の
  ときだけ取得し、超えたら `statusIncluded: false` で絞り込みを促す。
- デフォルトでは締切超過済み（due/cutoff の遅い方が過去）の課題を除外する
  （履修全体では課題60件でも、締切前に絞れば通常は数件で上限に収まる）。
  締切なし（`duedate=0`）は除外しない。`assignmentId` 指定時は過去分も返す。
- 検証: ローカル wrangler dev（`MOODLE_ORIGIN_OVERRIDE:cms.aitech.ac.jp`）で
  デフォルト/`dueWithinDays`/`includePastDue`（60件→`statusIncluded:false`）/
  `assignmentId`（締切超過分）/`nameFilter`/不正パラメータの各応答と、
  stdio MCP 経由のツール呼び出しを実データで確認済み。

### 12.11 テスト（クイズ）の受験状況確認（`mod_quiz_get_user_attempts`・参照のみ）

2026-07-14 実装。§12.10 の課題版と対になる、テスト（mod_quiz）の「未受験のテストが
あるか・期限はいつか」チェック用。`GET /api/moodle/quiz/status` と MCP ツール
`moodle_get_quiz_submission_status` を追加した。

- 一覧は `mod_quiz_get_quizzes_by_courses` を **courseids 省略**で呼ぶと全受講コースの
  クイズが1コールで返る（実データ確認済み: 5コース104件）。既存 quiz/info の
  コース単位取得と違い、横断チェックが subrequest 1 で済む。
- 受験状況は `mod_quiz_get_user_attempts`（`quizid` + `status=all`・1件1 subrequest）。
  応答 `attempts[].state`（`finished` / `inprogress`）と `timefinish` から
  `finishedAttempts` / `inProgressAttempts` / `finished` / `lastFinishedAt` を組み立てる。
  本番 `cms.aitech.ac.jp`（実データ・読み取りのみ）で応答形状確認済み。
- filter（`quizId` / `courseId` / `nameFilter` / `closeWithinDays` / `includeClosed`）と
  上限パターン（`MAX_ATTEMPT_STATUS_LOOKUPS` = 20、超過時 `statusIncluded: false`）、
  デフォルトで期限（`timeclose`）超過分を除外する挙動は §12.10 と同じ。
  期限なし（`timeclose=0`）は除外しない。`timeopen` が未来（受験開始前）のものも返す
  （期限が近いのに未開始、を検知させるため）。
- `mod_quiz_get_quizzes_by_courses` の応答にはコースIDしか入らないため、教科単位の
  グルーピング用に `core_enrol_get_users_courses`（+`core_webservice_get_site_info`、
  計 +2 subrequest）でコース名を解決し `courseName` として返す（課題版と揃えた）。
- 進行中（`inprogress`）の受験があると `mod_quiz_start_attempt` は
  `attemptstillinprogress` エラーになり、かつ既存ツールでは進行中 attempt の ID を
  取得する手段が無く再開できなかった。既に取得している受験履歴から
  `inProgressAttemptId`（複数あれば最新）を返し、`answer_quiz_question` /
  `finish_quiz_attempt` で再開・確定できるようにした。

## 13. 本番デプロイ（workers.dev）と /mcp リモートMCP 化

2026-07-14 実施。`aitapp-worker` を Cloudflare へデプロイし
（本番URL: **https://aitapp.shiki-01.com**（Custom Domain）。既定URL
https://aitapp-worker.kishintorii.workers.dev も併存。
KV: USER_KV=171403a15680458abc9da653d4931403 /
preview=365e6244b925476b9fecea11cf792e24）、同じ worker に MCP Streamable HTTP
エンドポイント `/mcp` を追加した。

### 13.1 【重要な制約】LCAM は Cloudflare の egress IP を拒否する

デプロイした worker からの LCAM (`lcam.aitech.ac.jp`) へのリクエストは、
**全て LiveCampus 自身のエラーページ（`SC_error`、「サーバ内部でエラーが発生
いたしました (Internal Server Error : 500)」）になる**。切り分け結果:

- ヘッダ非依存: UA/Sec-Fetch/Accept 一式・UAのみ・ヘッダ全く無し、のいずれも 500。
- ローカルIPからは、`--http1.1` + `Accept-Encoding: gzip` + `cf-worker` +
  `cf-ew-via` + `cdn-loop` を付けても 200（= CF が付与するヘッダや HTTP 版数は無関係）。
- `wrangler dev`（ローカル実行）は同一コード・同一 fetch 実装（workerd）で成功する
  （= TLS フィンガープリント説も否定）。
- 同 worker から Moodle (`cms.aitech.ac.jp`) とシラバス (`syllabus.aitech.ac.jp`)
  へは正常に 200 が返る。
- LCAM の応答ヘッダに `x-cdn: Served-By-Zenedge`（Oracle系 WAF）があり、
  **送信元 IP（Cloudflare データセンター帯）に基づく拒否**と結論づけた。

帰結:

- デプロイ版 worker では **LCAM 系（連絡・時間割・予定・成績・アンケート・添付）は動かない**。
  `/api/auth/login` も LCAM 検証を含むため、ブラウザ/Tauri からデプロイ版への
  ログイン自体が失敗する（Moodle/シラバスの API は login 前提のため巻き添えで使えない）。
- LCAM を含む全機能はローカル実行（`wrangler dev` + stdio MCP）で従来どおり動く。
- 回避するには LCAM 向けリクエストだけ非 Cloudflare の egress（例: 自宅サーバー経由の
  中継 proxy）を通す必要がある。**未実装（要検討）**。

### 13.2 /mcp（リモートMCP）の設計

- transport: MCP Streamable HTTP（`@hono/mcp` の `StreamableHTTPTransport`）。
  リクエスト毎に `McpServer` を生成する stateless 運用（DO 不使用の制約に適合）。
- ツール実装は `mcp/src/tools/*` を worker と stdio 版で共用する。tools が依存するのは
  `mcp/src/tool-client.ts` の `ToolClient` インターフェースのみ（Node 依存なし）。
  - stdio 版: `mcp/src/client.ts`（HTTP + ローカル一時ファイル保存）
  - worker 版: `worker/src/mcp/self-client.ts`（`app.fetch` への in-process dispatch +
    base64 返却、上限 10MB）
- 認証: `Authorization: Bearer <token>` または `/mcp/<token>`（SHA-256 ダイジェスト比較）。
  トークンは owner（env `MCP_TOKEN`）とユーザー別（§13.5）の 2 種類。
  （旧仕様の「env 未設定なら 404」は §13.5 でユーザー別トークンが常時有効になったため
  廃止。不正トークンは一律 401。）
- 資格情報は worker シークレット（`AITAPP_ID`/`AITAPP_PASSWORD`/`AITAPP_MOODLE_ORIGIN` 等）。
  内部呼び出し（`X-Aitapp-Internal: MCP_TOKEN` ヘッダ）に限り、認証ミドルウェアが
  env 資格情報から state をブートストラップする（`/api/auth/login` 不要）。これは
  (1) KV の negative cache（write 前の read miss が最大60秒残る）回避、
  (2) LCAM 不達環境でも Moodle/シラバスを動かす、(3) シークレット変更の即時反映、のため。
- session cookie は dispatch の度に `SESSION_SECRET` で自己署名（永続化しない）。
- zod / MCP SDK は `wrangler.toml [alias]` + `tsconfig paths` で worker 側
  node_modules に一本化（mcp/node_modules との二重バンドル・型不一致を防ぐ）。
- 検証済み（本番 /mcp 経由）: `initialize` / `tools/list` / `moodle_list_assignments`
  （実データ取得）/ `syllabus_get_filters`。`lcam_get_timetable` は §13.1 のとおり
  上流 500 エラーになる。

### 13.3 egress プローブ結果（2026-07-19）: 拒否は Cloudflare 帯限定

§13.1 の続き。「LCAM の WAF はデータセンター IP 全般を拒否するのか、Cloudflare
帯だけか」を GitHub Actions（Azure westus2、egress IP 20.120.220.145）から実測した
（`.github/workflows/lcam-egress-probe.yml`、workflow_dispatch / 自ファイル push で発火。
GitHub App 経由の API では workflow_dispatch が 403 になるため push トリガーを併設）。

結果: `GET https://lcam.aitech.ac.jp/portalv2/` が **HTTP 200** で本物の L-Cam
ログインページ（`<title>L-Cam</title>`、`Set-Cookie: JSESSIONID=...` 発行）を返した。
応答ヘッダに `server: ZENEDGE` / `x-cdn: Served-By-Zenedge` があり WAF 通過後の
正常応答であることを確認。

帰結: **Zenedge の拒否は Cloudflare の IP 帯に限定**で、非 Cloudflare の
データセンター IP（少なくとも Azure 帯）は通る。よって「LCAM 宛だけ非 Cloudflare の
無料サーバーレス（Deno Deploy / Vercel 等）に置いた中継 relay を経由する」構成が
自前ホストなしで成立する見込み。ただし実際に使うプラットフォームの egress 帯
（Deno Deploy=GCP、Vercel=AWS 等）は本プローブ未検証のため、採用時に同じ方法で
1 回プローブして確認すること（**要確認**）。

### 13.4 LCAM 中継 relay（Oracle Cloud 相乗り）

§13.3 を受け、採用構成を「既存の Moodle サンドボックス VM（Oracle Cloud Always Free、
固定 IP・cloudflared 稼働済み）に LCAM 専用の透過 relay を相乗りさせる」に確定した。
Oracle 帯の egress は `curl https://lcam.aitech.ac.jp/portalv2/` が **200** を返すことで
確認済み（§13.3 で通した Azure に加え Oracle も通過）。サーバーレス（Deno Deploy 等）は
共有 egress 帯のローテーション・帯単位 BAN・禁止ヘッダ検閲の懸念があり、固定 IP の
Oracle 相乗りを優先した（追加の保守コストは Moodle と共有のため実質増分なし）。

設計:

- **Worker 側**: LCAM の全アクセスが通る `worker/src/upstream/lcam/access.ts` の
  `lcamFetch()` に集約。`env.LCAM_RELAY_URL` / `LCAM_RELAY_TOKEN` があれば、宛先 URL を
  `X-Aitapp-Target` ヘッダに載せ `Authorization: Bearer` を付けて relay へ回す。未設定なら
  従来どおり LCAM へ直接 fetch（ローカル `wrangler dev` は未設定で直続）。relay 設定は
  deployment 定数のため `configureLcamRelay(env)`（`app.use('*')` で毎リクエスト注入）で
  モジュール変数に入れる（値不変のため isolate 再利用でも汚染なし）。Moodle/シラバスは
  別 access のため無改修。
- **relay 側**（`relay/relay.mjs`、依存ゼロの Node）: Bearer 認証・宛先を
  `https://lcam.aitech.ac.jp/` 前置のみ許可・GET/POST のみ。受信ヘッダ（Cookie/Origin/
  Referer/Sec-Fetch-*/User-Agent 等）と body を **node:https で verbatim 転送**する。
  これらは Fetch 仕様の「禁止ヘッダ」で spec fetch() だと落ちるため、CF Workers と同様に
  検閲しない node:https を使うのが要点。応答は status・body（stream）・Set-Cookie（複数
  保持）・Content-Type をそのまま返す。body はログに残さない（ログイン POST に平文資格情報）。
- **公開**: 既存 cloudflared トンネルに `relay.shiki-01.com → http://localhost:8090` を
  追加。inbound は CF 経由だが relay→LCAM の egress は Oracle 固定 IP なので WAF を通る。

配置・デプロイ手順は `relay/README.md`。

**エンドツーエンド検証済み（2026-07-19）**: Oracle VM（Moodle と同居、cloudflared に
`relay.shiki-01.com → localhost:8090` を追加）に relay を配置し、worker を
`LCAM_RELAY_URL="https://relay.shiki-01.com"` + `LCAM_RELAY_TOKEN` 有効でデプロイ。
本番 `/mcp` から `lcam_get_timetable` が実データ（週間時間割）を返すことを確認し、
§13.2 で 500 だった LCAM 系が解消した。relay→LCAM の禁止ヘッダ到達・SP セッション確立・
Cookie 透過・パースまで一連が機能。なお `LCAM_RELAY_URL` を `[vars]` でコメントのまま
デプロイすると（URL/TOKEN 両方揃わないと relay を使わない実装のため）直続 500 に戻る点に注意
（初回デプロイで実際に踏んだ。URL var の有効化 + 再デプロイで解消）。

### 13.5 /mcp のマルチユーザー化（ユーザー別トークン）

2026-07-19 実装。owner の env 資格情報を全員で共有せず、各ユーザーが自分の
資格情報で `/mcp` を使えるようにした。worker 管理者の運用負担（ユーザーごとの
シークレット設定・トークン配布）は発生しない。

- **発行**: ログイン済みユーザーが `POST /api/auth/mcp-token`（Web アプリの
  「その他 → Claude 連携 (MCP)」）で自己発行。失効は `POST /api/auth/mcp-token/revoke`、
  発行済みフラグは `GET /api/auth/me` の `mcp`。
- **形式**: `u.<base64url(userId)>.<乱数32byte hex>`（`worker/src/mcp/token.ts`）。
  uid を埋め込むことで token→uid の索引 key を KV に作らず、`user:{uid}` の
  1 read だけで検証できる（要件 §6 の key 分割禁止に適合）。uid 部分を改竄すると
  トークン全体の SHA-256 が変わり不一致になる。
- **保存**: KV の `UserState.mcpTokenHash` に SHA-256（hex）のみ。平文は発行応答
  でしか返さない。再発行で置換・revoke で null・logout で state ごと削除（＝失効）。
  再ログイン（`/api/auth/login`）は既存 state から `mcpTokenHash` を引き継ぐ
  （引き継がないと再ログインの度にコネクタが壊れる）。
- **実行時**: `worker/src/mcp/handler.ts` がトークン種別を判定し、ユーザー別なら
  `SelfClient` を user モード（uid の自己署名 cookie のみ、`X-Aitapp-Internal` なし）で
  生成。ツールは本人の KV state（暗号化 credential・上流 cookie・Moodle token）で動く。
- **書き込み系ツールは fail-closed**: out-of-band 確認秘密（`CONFIRM_SECRET`）を
  ユーザー別に受け渡す経路が無い（カスタムコネクタはヘッダ設定不可で、URL トークンが
  唯一の伝達手段＝out-of-band にならない）ため、user モードの `confirmSecret` は
  常に空にし、不可逆書き込み（クイズ・課題・アンケート提出等）は confirm_secret_unset
  で拒否する。閲覧系のみ提供。owner モードは従来どおり。
- **Google ログイン等の外部 IdP は導入しない（判断）**: ユーザーはどのみち LCAM の
  資格情報を登録する必要があり（スクレイピングに必須）、LCAM ログイン成功自体が
  本人確認になる。OAuth クライアント登録・コールバック・external state 管理を足しても
  認証強度は上がらず、要件の「過剰実装をしない」に反するため見送り。将来
  「登録できる人を絞る」必要が出たら、その時点で allowlist 等を検討する（要件外）。
- **無料枠への影響**: ユーザー別 /mcp は 1 ツール呼び出しあたり KV read が
  +1（トークン検証）で計 2 回。write は発行/失効時のみ。無料枠
  （read 100k/日・write 1k/日）に対しユーザー数十人規模でも余裕（§7 参照）。

## 14. LCAM の多要素認証（Entra ID SAML SSO）への対応（2026-09-24）

> **【更新 2026-09-25】** 本節は、ユーザーがブラウザで取得した Cookie を登録する方式の記録。**§15 で、本家アプリと同じ方式
> （`lamyapp://` の key → アプリ用資格情報で透過再ログイン）に置き換えた**。§14.2 の「再ログインとリトライは廃止」、§14.6 の
> keep-alive、§14.9 の Cookie 読み取りによる Tauri 自動再ログインは、現在は使っていない（履歴として残す）。Cookie 貼り付け登録は
> 代替として残っている。未確認・未対応の一覧は `docs/BACKLOG.md`。

LCAM は 2026-09-07 に Microsoft Entra ID の SAML SSO（パスワード + Outlook 番号入力の MFA）へ
移行した。旧方式（ID/パスワードを LCAM に直接 POST: `smartPhoneLogin` / `spAppLogin`）は
「アカウント/パスワードが間違っています」で拒否される。LCAM の Cookie は全て HttpOnly、
SAML の返り先はブラウザから LCAM へ直接（`/mellon/postResponse`）なので、Worker はログイン結果を
途中で受け取れず、MFA も Worker からは自動化できない。→ **ユーザーがブラウザでログインして
取得した Cookie を Worker に登録して使う**方式に変更した。

### 14.1 事実（ユーザー確認済み ／ 2026-09-24 に本セッションで実測）

ユーザー確認済み（前セッション）:
- 新フロー: `POST /portalv2/login/preLogin/preLogin` が `{"forwardParam":"Y"}` →
  `POST /portalv2/login/login/initLogin/sso` が 303 で `/mellon/login?...&IdP=https://sts.windows.net/1dd4d0da-…/`
  （LCAM 側は Apache mod_auth_mellon）→ Entra → `/mellon/postResponse` → `initLogin/sso` に戻り
  `JSESSIONID` と `LiveApps-Cookie` が発行される。
- Moodle `login/token.php` は現行のローカル資格情報でまだ動く（SAML ボタンも追加済み）。シラバスは認証不要（未確認）。

本セッションの実測（認証情報を使わない未ログインの GET/POST のみ）:
- `POST /portalv2/login/login/initLogin/sso` → 303、`Location` は**絶対 URL**
  `https://lcam.aitech.ac.jp/mellon/login?ReturnTo=…initLogin%2Fsso&IdP=https%3A%2F%2Fsts.windows.net%2F1dd4d0da…%2F`。
- SP ログイン画面（`/portalv2/sp`）にも SSO 経路がある（フォームの JS が
  `POST /portalv2/login/login/smartPhoneLogin/sso` へ遷移）。**ただしブラウザで通すと、最後に
  `lamyapp://lcam?key=…` へ引き渡されて L-Cam アプリが起動する**（ユーザー実測 2026-09-24。Entra の `kmsi` を経由）。
  ブラウザには LCAM の Cookie が発行されないため、**Cookie 取得には使えない**（当初「SP セッションが得られる見込み」
  と書いたのは誤りで訂正）。この引き渡し鍵の交換 API は推測せず、扱わない。
  Cookie を得る経路は PC 画面（`https://lcam.aitech.ac.jp/portalv2/` → `initLogin/sso`）。その Cookie が
  Worker の SP エンドポイント（時間割等）で通るかは未検証 → §14.4。
- 発行される Cookie: `JSESSIONID`（`path=/portalv2; HttpOnly; SameSite=None; Secure`）、
  `LiveApps-Cookie`（同属性、値は発行時刻 `yyyyMMddHHmmss` 形式）。mellon の Cookie は未ログインでは発行されない。
- **無効なセッションで SP データページを開くと、SSO への 303 ではなく 200 のスタブ**
  （約 850 byte、題「総合ポータルシステム」、本文「ログインされていないためシステムを利用できません」）。
  従来の「Struts token が無い応答 = 失効」判定（§9.4）がそのまま有効で、上記文言も検知に追加した。
  SSO への 303 は PC 画面・`initLogin/sso` 等で起き得るため、両方を検知する。
- `/portalv2/sp` のレスポンスに `Content-Security-Policy` ヘッダも meta CSP も無い（`X-Frame-Options: SAMEORIGIN` のみ）。
  ログイン後のデータページの CSP は未確認。

### 14.2 実装した内容（`worker/`・`mcp/`・`web/`）

- `POST /api/auth/login` は **Moodle 認証のみ**で通る（`invalidlogin` は 401、他は 502）。既存 state の
  `lcamCookies` / `lcamSession` は引き継ぐ（再ログインで登録済みセッションを失わない）。
- `GET/POST /api/lcam/session`: 登録状況の取得／Cookie の登録。登録前に SP 時間割へ 1 回アクセスして
  有効性を確認し、無効（422 `lcam_session_rejected`）なら保存しない。
  Cookie は `worker/src/upstream/lcam/cookies.ts` で検証（`JSESSIONID` / `LiveApps-Cookie` と
  `mellon*` のみ許可。Microsoft 側 Cookie は名前で拒否、値は RFC 6265 cookie-octet のみ）。
- MCP ツール `lcam_set_session`、Web 画面「その他 → LCAM 連携」（貼り付けフォーム＋登録/最終成功/失効の表示）。
- 失効検知（`upstream/lcam/detect.ts` + `access.ts`）: 上流リダイレクトは自動追従せず（`redirect: 'manual'`）、
  SSO（mellon / Entra / `*/sso`）への 3xx は `LcamExpiredError`、LCAM 以外のホストへは追従しない
  （Cookie を Microsoft 側へ送らない）。200 のスタブ/ログインフォームも従来どおり検知。
- `upstream/lcam/session.ts` の `withLcamSession`（旧 `relogin.ts` を置換）: 未登録・失効検知時は
  `LcamReauthRequiredError`。**パスワードでの再ログインとリトライは廃止**。失効を検知したら Cookie を破棄し
  `expiredAt` を記録する（以後 LCAM へは行かず即エラー）。ユーザーが同時に再登録していた場合に新しい Cookie を
  潰さないよう、書き込み前に KV を再読込して「使った Cookie がまだ同じ」ときだけ更新する。
- 再登録案内は **HTTP 424** `{ error: 'reauth_required', target: 'lcam', reason: 'not_registered'|'expired', message }`。
  Web の「401 → /login 誘導」や stdio MCP の「401 → 再ログイン」を誤作動させないため 401 を避けた。
  `message` に手順（ログイン → Cookie コピー（ログアウトしない）→ 登録）を含め、MCP と Web の両方に出る。
- セッション寿命の記録: `UserState.lcamSession = { registeredAt, lastOkAt?, expiredAt? }`。
  `lastOkAt` はデータ取得成功時に **1 ユーザー 1 時間に最大 1 回**だけ更新（KV 書き込み節約）。
  寿命は `[lastOkAt − registeredAt, expiredAt − registeredAt]` の範囲に入る。意図的な反復アクセスはしない。
- `/api/schedule`（予定）は**未対応**（HTTP 501 `not_supported`、LCAM へはアクセスしない）。PC 画面の取得コード
  （`fetchSchedule` / `getPcHomeBody` / `reload` / `getScheduleNext`）は削除した（履歴から復元可。パーサ `parseSchedule` は残置）。
  理由は §14.4（PC 画面への直接 GET でセッションが破棄される）。MCP の `lcam_get_schedule` も外した。
- `worker/scripts/lcam-cookie-probe.ts`: Cookie の最小組み合わせを実測するローカル用スクリプト（読み取り専用、最大 4 GET）。
- ローカル `wrangler dev` での実データ検証（2026-09-24、PC 画面ログインで得た Cookie を Web 画面から登録）:
  偽の Cookie は 422 で拒否、正規 Cookie は登録成功。時間割・連絡・成績（17 件）・授業アンケート一覧が取得できた。
  未検証: 本番（relay 経由）、アンケート回答系の書き込み、Cookie の寿命。

### 14.3 やらないこと

- 大学の Microsoft アカウントの Cookie/トークンの保存（アカウント全体のセッションになるため）。
- MFA・番号入力の自動化/回避。L-Cam 公式アプリのローカル保存領域からの資格情報抽出。
- ログイン済みセッションを反復アクセスして寿命を探る作業（寿命は §14.2 の記録から自然に測る）。
- 自動再ログイン・keep-alive・自動復旧（従来どおり）。

### 14.4 要確認（未確定事項）

| 項目 | 状況 | 確認方法 |
|------|------|----------|
| 必要な Cookie の最小セット | **確認済み（2026-09-24、ユーザー実測）**: SP 時間割は `JSESSIONID` のみで通る。`LiveApps-Cookie`・`mellon*` は不要（mellon の Cookie はブラウザには存在した）。ただし書き込み系（アンケート提出等）での要否は未確認のため、登録 API は当面 `LiveApps-Cookie` も要求する | `lcam-cookie-probe.ts` |
| LCAM セッションの寿命 | 未確認 | 登録後は普通に使い、`GET /api/lcam/session` の `registeredAt`/`lastOkAt`/`expiredAt` を見る |
| Worker（relay 経由を含む）から Cookie を使ったときの動作。ブラウザとは IP・User-Agent が異なる（Worker は Android UA 固定）ため、セッションが IP/UA に紐付いていれば拒否される可能性 | **確認済み（2026-09-24）**: ローカル `wrangler dev`（ブラウザと同一 IP・Worker の Android UA）と、本番 `aitapp.shiki-01.com`（relay 経由の Oracle IP・Android UA）の両方で、ブラウザ（デスクトップ UA）で取得した Cookie の登録と SP 画面の表示に成功。**IP/UA への紐付けは無い**（少なくとも SP 画面では）。relay が 3xx/ヘッダを素通しする点は失効時の実動作のみ未確認 | – |
| PC 画面ログインの Cookie が SP 画面（時間割・連絡等）で通るか。SP 経路の SSO はアプリ連携のためブラウザで Cookie を得られず、PC 画面ログインが唯一の取得経路 | **確認済み（2026-09-24）**: PC 画面ログイン（`/portalv2/`）で得た Cookie で SP 時間割（題「個人時間割」）が取得できた（Mac から直接接続） | `lcam-cookie-probe.ts` |
| PC スケジュール（`/api/schedule`） | **（§16 で再検討。下は 2026-09-24 時点の実測）未対応で確定（2026-09-24 実測）**。PC ホーム `common/generalPurpose/` へ Worker から GET（デスクトップ UA・Referer・全 Cookie でも同じ）すると 200 で「不正な操作が行われました。システムエラーにより利用を継続することができなくなりました。ログインしなおして下さい」（題「総合ポータルシステム」、約 3 KB）が返り、**`Set-Cookie` で新しい `JSESSIONID` が発行されるが、旧・新どちらでも SP 時間割は無効＝登録済みセッションが破棄される**。ブラウザで動くのはアプリ内の画面遷移（POST・token・遷移元の状態）を経ているためと推測。SP 側に予定画面は Dart 定義に無い。→ Worker から PC 画面には**絶対に GET しない**。取得するなら、ブラウザ/Tauri の WebView がログイン済みセッションで正しく遷移して読み取る方式（§14.5 の B/A）が要る。旧メモ（参考）: 実測: `GET /portalv2/` は**認証済みでもログイン画面**（題「L-Cam」）を返すためホームではない。PC ホームはユーザー観測で `/portalv2/common/generalPurpose/`（ログイン直後は `initLogin/sso`）。その token で `POST home/home/reload`（Dart 由来）が通るかを試す | — |
| ブラウザでの再ログイン/ログアウトが登録済みセッションを無効化するか（旧方式は単一セッションだった。§9.4） | **確認済み（ユーザー報告 2026-09-24）**: **別端末でログインすると他の端末は全部ログアウトされ、aitapp の登録セッションも失効した**（ユーザーあたり単一セッション）。手順では「ログアウト・再ログインしない」を案内 | – |
| LCAM セッションの継続時間 | **keep-alive で 1 時間 40 分以上の維持を確認済み（§14.6）**。ユーザー報告: **PC 版ブラウザは 1 時間 30 分（操作でリセットされる）**（画面表示。無操作での失効か絶対時間かは未確認）。**L-Cam アプリ版にはこの制限が適用されない**（アプリは `lamyapp://` の引き渡し鍵経由で別経路のセッションを持つと推測。交換 API は未調査・推測しない） | 登録画面の登録/最終成功/失効の時刻と、PC 画面の表示が操作でリセットされるかの観察 |
| mellon の Cookie の有無・path | 未観測（未ログインでは発行されない） | 正規ログイン後の DevTools |
| relay が 3xx と `Location` を素通しするか | `relay.mjs` は status と全応答ヘッダを返す実装（コード上は問題なし）。実 LCAM での動作は未確認 | 失効 Cookie で本番の `lcam_get_timetable` を 1 回叩く |
| Moodle のローカル認証がいつまで使えるか | 不明（SAML ボタン追加済み。止まると `/api/auth/login` 自体が通らなくなる） | 定期的に `login/token.php` の成否を見る。止まったら Moodle の SSO 対応が別途必要 |
| ログイン後データページの CSP | 未確認 | ブックマークレット案（§14.5）の前提 |

### 14.5 スマホ向けの検証結果とおすすめ

前提: スマホには DevTools が無く、手動の Cookie コピー（§14.2 の方式）は現実的でない。
ユーザーの手間の少なさを最優先し、開発コストは度外視して比較した（調査は Tauri 2.11.5 / wry 0.55.1 の
ソースと公式ドキュメント。**iOS/Android 実機では未検証**）。

| 案 | 可否 | ユーザーの手間 | 主な根拠・制約 |
|----|------|----------------|----------------|
| **B. ネイティブ WebView アプリ（Tauri v2 モバイル）** | 要実機検証（ソース上は可）。SSO は `/portalv2/sp` ではなく PC 経路（`/portalv2/`）を WebView で通す必要がある（SP 経路は `lamyapp://` へ引き渡され Cookie が出ない） | 初回に MFA ログイン 1 回、以後は自動 | `Webview::cookies_for_url` は tauri 2.4.0 で追加、HttpOnly/Secure も返す。Android は `CookieManager.getCookie`（Chromium 実装は HttpOnly 含む）、iOS は `WKHTTPCookieStore`。Android では `cookies()` が空を返すため `cookies_for_url` を使う。iOS の `cookies_for_url` は domain 完全一致のため `cookies()` を全件取得して自前フィルタする |
| **A. ブックマークレット（同一オリジンで取得 → Worker へ送信）** | 要実機検証 | ログインのたびに ブックマークを開く | HttpOnly は読めないため Cookie は取れず、HTML のスナップショット送信のみ（読み取り専用・鮮度はその時点）。CSP は `/portalv2/sp` には無い（データページは未確認）。iOS Safari でブックマークレットが動くかは資料が割れている（iOS 15 以降不可の報告と、2026-02 付の大学ガイドで可）。Worker への POST は CORS と、SameSite=Strict の session cookie が使えないための専用ワンタイムトークンが必要 |
| C. Firefox Android + 拡張 | 可（自作拡張・AMO 署名が必要） | Firefox 導入 + 拡張導入 | `cookies` API は HttpOnly も返す。iOS には使えない |
| iOS ショートカット単体 | 不可 | – | ページ内 JS のみで Cookie は取れない |
| Kiwi Browser | 不可 | – | 開発終了 |

Tauri モバイルの流用可否（リポジトリ確認）:
- `web/`（SvelteKit）と `api.desktop.ts`（invoke 経由）はそのままモバイル WebView に載せられる。
  `tauri.conf.json` の `frontendDist` 等も流用可。
- 要改修: `tauri/src-tauri/gen/` に apple/android が無く `tauri ios init` / `android init` が必要。
  モバイル用の `lib.rs` + `mobile_entry_point`、`keyring` は Android の対応 store が無く代替が必要。
  `commands.rs` の「保存済みパスワードで無言再ログイン」は Moodle 用としては有効だが LCAM には効かない。
- 既知の不具合: wry 0.55.1 の Android は Cookie が無い URL で `getCookie` が null になり NPE の可能性
  （修正 PR は wry 0.57.1 向け）。wry を上げる必要がある。
- 配布: iOS は Apple 無料アカウントだと 7 日で失効・3 アプリまで（自分の端末の PoC 専用）。他ユーザーへの配布は
  Apple Developer Program（有料）が事実上必須で、「有料機能を使わない」方針と衝突する。Android は APK 配布で可。

**おすすめ**:
1. （完了）§14.4 の最初の 3 項目は確定済み: 最小 Cookie は JSESSIONID のみ、IP/UA 紐付けなし、PC 画面ログインの
   Cookie が SP 画面で通る。よって Cookie 方式（B・C）は成立する見込み。
2. **B（Tauri モバイル、Android 先行）** を自分の端末で PoC する。手間が最小（「接続」をタップして MFA を
   通すだけ）で、Worker 側は既存の `POST /api/lcam/session` をそのまま使える（アプリが Cookie を読んで登録するだけ）。
   iOS は PoC までは無料アカウントで可能、配布時のみ有料プランが論点になる。
3. iOS の無料配布を優先するなら A を検討する。ただし読み取り専用のスナップショットで、
   既存のパーサ（`parse.ts`）は HTML を入力に取る純関数なので Worker 側で流用できるが、
   MCP からは「最後に取り込んだ時点のデータ」しか見えない。iOS Safari で動くかの実機確認が先。

### 14.6 keep-alive（Cron Trigger）と無料枠の見積もり

> **【廃止 2026-09-24】** アプリ方式（§15）への移行で、失効しても Worker が保存済みの資格情報で透過再ログインできるように
> なったため、keep-alive（`keepalive.ts`・Cron Trigger）は削除した。以下は当時の記録（1 時間 40 分以上の維持を確認した根拠）。

LCAM のセッションは「無操作 1 時間 30 分」で切れ、操作でリセットされる（ユーザー実測 2026-09-24）。
これを受け、**登録済みユーザーに 30 分ごとに SP 時間割へ 1 回 GET する keep-alive** を実装した
（要件 §11 の「keep-alive は実装しない」をユーザー指示で外した。`worker/src/keepalive.ts`）。

- Cron は `*/10 * * * *`（`wrangler.toml [triggers]`、末尾に置く）。ユーザーを userId のハッシュ（FNV-1a）で
  3 グループに分け、1 回の実行では 1 グループだけを処理する（各ユーザーは 30 分ごと）。1 回に処理する人数は
  上限 20（`MAX_PER_RUN`）。超過は warn ログ `keepalive capped`。
- 効果は「無操作での失効の防止」のみ。絶対時間の上限があれば失効を検知して `expiredAt` を記録するだけで、
  自動再ログインはしない（MFA のため不可能）。keep-alive があるため失効は 30 分以内に検知され、
  寿命は `expiredAt − registeredAt`（±30 分）で測れる。`lastOkAt` の更新は 3 時間に 1 回に間引いた。
- 別端末/別ブラウザ/アプリで LCAM にログインすると、単一セッションのため登録済みセッションは失効する
  （keep-alive では防げない）。再登録が要る。
- ローカルで `wrangler dev --test-scheduled` の `/__scheduled` から実行し、ハンドラが動くことと
  `keepalive done` ログを確認済み。
- **本番での実効性を確認済み（2026-09-24）**: 11:38:27 に登録 → ユーザーは LCAM に一切触れず放置 → keep-alive の Cron が
  12:00 に `targets 1 / alive 1` → **13:18（登録から約 1 時間 40 分。無操作の上限 1 時間 30 分を超過）に LCAM の実データが
  取得できた**（失効の表示なし）。SP 時間割への軽い GET が「操作」として無操作時間をリセットする。
  絶対時間の上限は 1 時間 40 分までは存在しない。それ以上は未確認（「その他 → LCAM 連携」の失効検知時刻で今後観察する）。

無料枠の見積もり（**筆者の概算。デプロイ前に Cloudflare の現行ドキュメントで再確認すること**。§7 の値を前提）:

| 項目 | 1 ユーザーあたり / 日 | 無料枠 | 人数の上限の目安 |
|------|-----------------------|--------|------------------|
| Cron 起動（Workers リクエスト） | 全体で 144 | 100,000 | 影響なし |
| KV list | 全体で 144 | 1,000 | 影響なし（人数に依存しない） |
| KV read | keep-alive 48 ＋ 通常利用 | 100,000 | 約 1,000 人以上 |
| **KV write** | lastOkAt 8 ＋ 登録・失効・ログイン等で約 2〜4 ＝ 約 10〜12 | 1,000 | **約 80 人（律速）** |
| relay 経由の LCAM GET | 48（Oracle VM 側。無料） | – | 影響なし |
| 1 回の Cron の subrequest | 対象ユーザー数（≤20）＋ KV 操作 | 50 / 実行 | 20 人/実行なら収まる見込み |
| 1 回の Cron の CPU | 1 ユーザーあたり 0.5〜1 ms と推定 | 10 ms / 実行（無料） | **未実測**。20 人/実行で超える可能性があり、超えたら `MAX_PER_RUN` を下げるか shard 数を増やす |

- 実質の上限: 1 グループ 20 人 × 3 グループ = **60 人**（KV write の約 80 人より先に頭打ちになる）。
  1〜10 人規模なら余裕がある。それ以上は、shard 数（`KEEPALIVE_SHARDS` と cron の間隔）を増やすか、
  ping 周期を 45 分程度まで延ばす（無操作 90 分に対して余裕は減る）。
- Cron Trigger 自体は無料プランでも使える（アカウントあたりの上限数は要確認。本 Worker は 1 本）。

### 14.7 90 日の再認証（Entra の「サインインの状態を維持」が切れたとき）

Worker は Microsoft のセッションを持たない（Cookie を保存しない方針）。90 日の期限が切れるのは
ユーザーのブラウザ側の Microsoft セッションで、その場合の LCAM ログインで Entra が番号入力の MFA を求める。
手順は通常の再登録と同じ（PC のブラウザで `/portalv2/` にログイン → MFA → Cookie をコピー → 登録）。
現状、スマホ単体では DevTools が無く再登録できない（Firefox for Android + Cookie-Editor 系拡張は調査上は
可能だが未検証）。スマホで完結させるには §14.5 の B（Tauri モバイル: WebView でログインし Cookie を自動登録）が要る。

### 14.8 セキュリティ自己レビュー（2026-09-24、今回の変更範囲）

確認した点（問題なし）:
- 実値の Cookie・引き渡し鍵・Microsoft Cookie はリポジトリに含まれない（テストはダミー値）。`.env` / `.dev.vars` は gitignore 済み。
- ログに Cookie・userId を出さない（keep-alive は相関 ID・件数・例外名のみ。`onError` の `detail` は例外文言で、
  LCAM 関連の例外文言は URL・ステータス・ホスト名のみ）。Cookie 検証エラーは Cookie 名のみを返し値は返さない。
- Cookie 値はヘッダ注入を防ぐため RFC 6265 の cookie-octet に限定。Microsoft 側 Cookie は名前で拒否（保存しない）。
- 上流リダイレクトは自動追従せず、LCAM 以外のホストへは追従しない（Cookie を Microsoft 側へ送らない）。
- `POST /api/lcam/session` は Origin チェックと session cookie を要求する。

修正した点（2026-09-24、本番ログの確認で発覚）:
- エラーログの `path` に `/mcp/<ユーザー別トークン>` がそのまま出ていた（Bearer 相当の資格情報）。`redactPath` で
  `/mcp/[redacted]` にした。あわせて、上流タイムアウトのエラー文が URL 全体（Moodle のファイル取得は `?token=`
  付き）を含んでいたため、クエリを除いた表記にした。`[observability]`（ログの永続化）を有効にする前に修正した。
  ログに出たトークンは再発行（その他 → MCP URL を再発行）で無効化できる。

既知の残存リスク（許容・要認識）:
- `lcam_set_session`（MCP）は Cookie をモデルの引数として受けるため、上流データ内のプロンプトインジェクションで
  攻撃者の Cookie を登録させられ得る（他人のデータが表示される。ツール説明で「会話でユーザーが渡した値のみ」と制約）。
  Cookie がチャット履歴に残る点も含め、Web 画面からの登録を推奨。
- `POST /api/lcam/session` は 1 回ごとに LCAM へ 1 GET する。認証済みユーザーが連打すると LCAM への負荷になり得る
  （レート制限なし。ユーザー数十人規模の前提で許容）。
- Cookie 自体は KV に平文で保存される（従来の上流 Cookie と同じ扱い。credential のみ AES-GCM 暗号化）。
  Cookie は 1 時間 30 分の無操作 or 単一セッションで失効する短命の値であるため許容。
- KV の結果整合性: 登録・失効の書き込み直後、別のエッジからの読み取りが最大 60 秒ほど古い state を返し得る
  （登録直後に「未登録」エラーが一瞬出る、失効の二重検知など。害は小さい）。

### 14.9 Tauri 自動再ログイン（デスクトップ版は実装済み・実機での SSO 通過は未検証）

> **【置換 2026-09-25】** PC 経路（`/portalv2/`）の SSO を通して Cookie を読む方式は、§15 の SP 経路（`/portalv2/sp`）で
> `lamyapp://` の key を傍受する方式に置き換えた（`tauri/src-tauri/src/lcam_login.rs`）。以下は当時の設計メモ。

目的: 失効/別端末ログインでセッションが切れたとき、デスクトップの Tauri が Cookie を自動で取り直して
`POST /api/lcam/session` に登録し直す（手動の再登録をなくす）。Microsoft のセッションは Tauri の WebView
（OS 管理のプロファイル）内にだけ残り、Worker には送らない。

流れ:
1. 契機: 起動時と一定間隔で `GET /api/lcam/session` を確認し、`registered: false`（または API が 424）なら実行。
   同時に 1 回だけ実行する。
2. 非表示の WebviewWindow（永続プロファイル）で `https://lcam.aitech.ac.jp/portalv2/` を開く。
3. ログイン画面の「ログイン」ボタンは `excludeSubmit()` を呼ぶ（2026-09-24 に公開 HTML で確認）。これが
   `preLogin/preLogin`（JSON）→ `forwardParam: Y` → `initLogin/sso`（POST、mellon → Entra）へ進む。
   WebView で `eval("excludeSubmit()")` を実行して SSO を開始する。ID/パスワード入力は不要（SSO のため）。
4. ナビゲーションを監視する。Entra が「サインインの状態を維持」のセッションで自動的に戻れば LCAM のホームに着地する
   （ユーザー実測: 番号入力なしでリダイレクトのみ）。Entra 画面で一定時間止まる（番号入力や `kmsi` の対話が要る）
   場合は、ウィンドウを表示してユーザーに操作してもらう（MFA の自動化・回避はしない）。
5. 着地（`lcam.aitech.ac.jp/portalv2/` 配下でログイン済み）を検知したら、async コマンドで
   `cookies_for_url("https://lcam.aitech.ac.jp/portalv2/")` から `JSESSIONID`（＋あれば `LiveApps-Cookie`）を読む
   （Windows は同期コマンドだとデッドロック、macOS/iOS の `cookies_for_url` は domain 完全一致のため `cookies()` を
   全件取得して自前フィルタ）。
6. 既存の Rust `UpstreamClient` で Worker に `POST /api/lcam/session`（Worker が有効性を確認して保存）。
7. ウィンドウを閉じる。

注意・要検証（keep-alive の確認が終わってから。LCAM へのログインは登録済みセッションを無効化するため）:
- WebView（macOS の WKWebView、Windows の WebView2）で、Entra の持続セッションのまま MFA なしに戻れるか。
- `cookies_for_url` が HttpOnly の `JSESSIONID` を返すか（プラットフォーム別）。
- 更新のたびに他端末（ブラウザ・公式アプリ）の LCAM セッションが切れる（単一セッション）。
- Entra の持続セッションの期限（ユーザー報告では約 90 日）と、テナントの再認証ポリシー。
- Tauri が起動していない間は更新されない（keep-alive で維持できる範囲に限る）。
- 実装規模の見積もり: Rust コマンド 100 行前後、権限設定、Web に状態表示、実機の手動検証。単体テストで担保できない部分が大きい。

実装状況（2026-09-24）:
- `tauri/src-tauri/src/lcam_login.rs`: WebView（ラベル `lcam-login`）で上記の流れを実行し、Worker の `POST /api/lcam/session` に登録する。
  純粋関数（URL の段階判定 `classify`、Cookie 文字列の組み立て `build_cookie_header`）は `cargo test` で単体テスト済み（4 件）。
  LCAM ドメインの Cookie だけを送る（Microsoft 側の Cookie は WebView の外に出さない）。
- 手動: 「その他 → LCAM 連携」の **「LCAM に接続」**（ウィンドウを表示。番号入力などはそのまま操作）。
- 自動（オプトイン、既定オフ）: `lcam_auto.rs`。アプリ起動中、5 分ごとに Worker の登録状況を確認し、未登録/失効なら
  ウィンドウを出さずに再接続する。対話が要るときは自動では進めず 6 時間停止、失敗後は 30 分のクールダウン。
- Worker: 登録 API は `JSESSIONID` のみ必須に緩めた（`LiveApps-Cookie` は任意。§14.4 の実測による）。
- **未検証**: WebView での実際の SSO 通過（Entra のセッション維持で番号入力なしに戻れるか）、macOS の WKWebView で
  `cookies_for_url`/`cookies()` が HttpOnly の JSESSIONID を返すか、初回の `excludeSubmit()` 実行のタイミング。
  これらは LCAM に実際にログインするため、登録済みセッションが無効になる。試すときは他の LCAM 利用が無い状態で行う。

### 14.10 スマホ版（Tauri モバイル / iOS）の現状

方針: **署名なしの IPA を GitHub Actions でビルドして配布**する。端末へは AltStore / SideStore / Sideloadly 等が、
自分の（無料の）Apple ID で再署名して入れる。**有料の Apple Developer Program は不要**（無料アカウントの署名は 7 日で失効。
AltStore/SideStore は同じ Wi-Fi 上で自動更新できる。同時に入れられるアプリ数などの制限あり）。

実装済み（2026-09-24）:
- `lib.rs`（`run()` + `#[cfg_attr(mobile, tauri::mobile_entry_point)]`）/ `main.rs` の分割、`[lib] crate-type`。
- `tauri/src-tauri/tauri.ios.conf.json`: iOS 用のビルドコマンド（`build:mobile`/`dev:mobile`）と最低 OS（15.0）。
- web: `isTauri`（invoke 経由の API・PWA 無効化）と `isDesktop`（PC 用レイアウト）を分離。`--mode mobile`（`.env.mobile`）で
  スマホ用レイアウト（BottomNav）＋ Tauri API。自動再接続の切替は PC のみ。
- ログイン用 WebView: モバイルでは **PC の User-Agent を付ける**（スマホ UA だと LCAM が SP 画面へ回し、SSO の終端が
  `lamyapp://` のアプリ連携になって Cookie が出ない可能性があるため。UA 依存の挙動自体は未確認）。自動再接続ループはデスクトップのみ。
- 資格情報の保存: `keyring`（iOS は Keychain。crate が iOS 対応）。
- **`.github/workflows/ios-ipa.yml`**（手動実行）: macOS ランナーで `tauri ios init` → 署名無効化 → `tauri ios build` →
  `.xcarchive` の `.app` を `Payload/` に入れて署名なし `.ipa` を作り、artifact（保持 7 日）にする。
  **ビルドが通り、arm64・Bundle ID `com.aitapp.desktop`・iOS 15.0・署名なしの IPA が出来ることを確認済み**（run 35962295698、約 3 MB）。
  private リポジトリでは macOS ランナーが無料枠を 10 倍で消費する（1 回 1〜数分だが、キャッシュなしだと 10 分超もあり得る）ため手動のみ。
- `tauri/package.json`: Xcode の「Build Rust Code」手順が `npm/bun run tauri` を `gen/apple` の上位で探すために必要（無いと失敗する）。

**実機では未検証**（以下は端末で確認が要る）:
1. 再署名して起動できるか。Bundle ID は再署名ツールが変更する場合がある（無料アカウントでは一意化されることが多い）。Keychain が動くか。
2. ログイン用 WebView（`WebviewWindowBuilder` の追加ウィンドウ）が iOS でどう表示され、閉じたあとにアプリ本体へ戻るか
   （公式ドキュメント: iPhone では新しいウィンドウが現在の UI を置き換えることが多い）。
3. WKWebView で `cookies_for_url` / `cookies()` が HttpOnly の `JSESSIONID` を返すか、`delete_cookie` が効くか。
4. `/portalv2/` に PC の UA で入って SSO が通り、番号入力（Authenticator/Outlook）を WebView 内で完了できるか。
5. 連絡の添付ファイルの取得（`download_file` → `tauri-plugin-opener` で開く）が iOS で動くか。

Android: 構成上は `lib.rs`/`tauri.conf` の流用が可能だが未着手。Android には `keyring` の保存先が無く代替が要る。`cookies()` は空を返す
（`cookies_for_url` を使う実装済み）。wry 0.55.1 の Android は Cookie が無い URL で NPE の可能性があり wry の更新が要る。

IPA の入手と導入:
1. GitHub の Actions →「iOS IPA (unsigned)」→「Run workflow」。完了後、その実行の Artifacts から `aitapp-unsigned-ipa` をダウンロード
   （zip の中に `aitapp-unsigned.ipa`）。
2. AltStore / SideStore / Sideloadly で、自分の Apple ID を使って端末に入れる（7 日で再署名が要る）。
3. アプリで Moodle にログインし、「その他 → LCAM 連携」→「LCAM に接続」を押して、開いた画面で Microsoft のログインを通す。

## 15. 本家 L-Cam アプリ（Android v2.1.2）の静的解析（2026-09-24）

目的: PC 版ブラウザで LCAM にログインしても aitapp のセッションが失効しない（本家スマホアプリと同様）ようにする方法の調査。
方法: 公式 APK（`lcam-2.1.2.apk`、Ionic/Angular + Cordova のハイブリッド。`assets/www/main.js` に平文の JS が入っている）を
**展開して JS を読んだだけ**（LCAM へのアクセス・ログインは一切していない）。APK と展開物は repo に含めない。

### 15.1 判明した本家アプリのログイン方式（コード上の事実）

1. **初回サインイン**: 標準ブラウザで `POST /portalv2/login/login/smartPhoneLogin/sso`（§14.1 の SP 経路の SSO）を開く。MFA を通すと
   終端が `lamyapp://lcam?key=<K>` でアプリに戻る（Deeplink ルート `/lcam`、クエリ `key`）。
2. **`key` の交換**: アプリは `POST https://lcam.aitech.ac.jp/portalv2/login/login/spAppLogin/`
   （`Content-Type: application/x-www-form-urlencoded`、body: `userId=<K>`, `password=`（空））を送る。
   応答 JSON: `status`（`success` / `fail` / `stop_login`）、`userId`、`password`、`role`。
   ※旧方式（§3.2 `canLoginLcam`）と同じエンドポイントで、`userId` に key を入れる使い方。**`password` は SSO ユーザーの本物のパスワードではなく、
   サーバーが発行するアプリ用の値と推測される（未確認）**。アプリはこの `userId` / `password` をローカルに AES-GCM で暗号化保存する。
3. **以後の認証（画面を開くたび）**: `GET /portalv2/sp` → `POST /portalv2/login/login/smartPhoneLogin/`
   （body: `userID`, `password`（2 の値）, `selectLocale=ja`, `mode=sp`, `userDivision=2`, `spAppFlag=1`, `spFlg=1`, `locale=ja`,
   **`lCamApp=Y`**, `clientLocationUrl=https://lcam.aitech.ac.jp/`）。応答 JSON の `status` が `fail` なら失敗、`stop_login`（`stopLoginFlag=1`）はログイン制限。
   得た Cookie に **`L-CamApp=Y`** を足して WebView に渡す。つまり本家アプリは長寿命のセッションを持たず、
   保存済みの `userId` / `password` で **MFA なしに SP セッションを作り直している**。
4. アプリの PC 版・Moodle への遷移（`preLogin/preSpAppSso`）も、同じ保存値を Blowfish で暗号化した `para` で渡している
   （Dart 実装 `main_drawer_usecase.dart` と同じ。今回は扱わない）。

### 15.2 意味すること

- PC 版ブラウザと共存できるのは、アプリ経路が **`spAppFlag=1` / `lCamApp=Y` の別種のログイン**（アプリ用の資格情報）だからと考えられる。
  Worker が現在使っている Cookie は PC 画面（`/portalv2/`）の SSO で得たもの（§14.1、SP 経路の SSO はブラウザに Cookie を出さないため）で、
  PC 版ブラウザと同一の単一セッション枠にある。
- 方式案: 初回だけ、SP 経路の SSO を Tauri の WebView で通し、`lamyapp://lcam?key=…` へのナビゲーションを傍受して `key` を得る →
  `spAppLogin/` で交換 → 得た `userId` / `password` を **AES-GCM（`CRED_KEY`）で暗号化して KV に保存** → Worker が `smartPhoneLogin/`
  （上記 3）で SP セッションを作る。

### 15.3 当初の未確認事項（§15.5 で実測。残りは下表の「未確認」）

| 項目 | 備考 |
|------|------|
| `key` が使い捨て・短命か | 交換に失敗すると再度 MFA が要る |
| `spAppLogin/` の `password` が再利用できるか、有効期間 | アプリは毎回この値でログインしているため再利用可の見込み |
| **アプリ経路のログインが PC 版ブラウザのセッションを無効化しないか／逆に無効化されないか**（本要望の核心） | **実測済み: 互いに無効化する（単一セッション）**。§15.5 |
| `lCamApp=Y` の必須性、`L-CamApp=Y` Cookie の意味 | 両方送るのが安全。SP データページ（時間割・連絡・成績・アンケート）で通るかも要確認 |
| `key` を Tauri WebView（Windows: WebView2 / iOS: WKWebView）で傍受できるか | カスタムスキームのナビゲーションを `on_navigation` で捕捉する想定 |
| Worker（relay 経由）からの `spAppLogin/`・`smartPhoneLogin/` の可否 | 旧方式は Worker から動いていた（§9.4）。CF egress IP の WAF 拒否（§13.1）は relay で回避 |

### 15.4 方針上の論点

- §14.3「MFA の自動化/回避はしない」「公式アプリのローカル保存領域からの資格情報抽出はしない」との関係:
  本案は、ユーザーが自分で MFA を通した直後に公式と同じ手順で発行される値を受け取るだけで、アプリの保存領域は読まない。
  ただし以後は保存した値で **MFA なしにセッションを再作成できる**ため、自動再ログインをしない方針（要件 §11）とは性質が変わる。
  実装する場合は、この保存値を資格情報として扱う（暗号化・ログに出さない・失効時は破棄）。

### 15.5 実測結果（2026-09-24、`worker/scripts/lcam-app-login-probe.ts` で本人のアカウントを使って実施）

| 確認 | 結果 |
|------|------|
| `spAppLogin/` での key 交換 | **成功**。`{status, userId(8 文字), password(90 文字), role}`。`password` はサーバー発行のアプリ用トークン |
| 保存値での `smartPhoneLogin/`（`spAppFlag=1`・`lCamApp=Y`・`L-CamApp=Y` Cookie） | **成功**。応答は HTTP 200 の HTML（約 17 KB。JSON ではない）、`Set-Cookie` なし。**`GET /portalv2/sp` で得た JSESSIONID をそのまま使える**（rotate されない）。SP 時間割が取得できた |
| ログイン後、PC 版ログインをせずに 5 秒後に確認 | セッションは有効（OK） |
| **PC 版ブラウザでログイン後**、直前のアプリ経路セッションで SP 時間割 | **失効（NG）**。PC 版ログインはアプリ経路のセッションも無効化する |
| **アプリ経路でログイン後**、PC 版ブラウザの画面 | **PC 版がログアウトされた**（ユーザー確認） |

結論:
- アプリ経路でも**ユーザーあたり単一セッション**は変わらない。「本家アプリが PC 版ログインで切れない」ように見えるのは、セッションを持ち続けている
  のではなく、**画面を開くたびに保存済みの資格情報でログインし直している**ため（アプリの `authCookies` は `openUrl` のたびに呼ばれる）。
- 得られる利点は「PC 版などで切れても、次の操作で MFA・再登録なしに自動復帰する」こと。代償は、再ログインのたびに他の場所（PC 版ブラウザ・
  公式アプリ）のログインが切れること。
- そのため **keep-alive は削除**した（失効しても再ログインで復帰でき、定期的なアクセスの利点が無い。定期的な再ログインは他の場所を切り続けるので行わない）。

### 15.6 実装（2026-09-24）

- `worker/src/upstream/lcam/app-login.ts`: `parseAppKey`（URL 丸ごと / key のみ）、`exchangeAppKey`、`appLogin`（`GET /portalv2/sp` → `POST smartPhoneLogin/`
  → SP 時間割で有効性確認）。LCAM への通信は relay 対応の `lcamFetch`（access.ts）を使う（本番は LCAM が Cloudflare の egress IP を拒否するため。§13.1）。
- `UserState.lcamApp`: `{userId, password}` を AES-GCM（`CRED_KEY`）で暗号化した値。`/api/auth/login` での state 再構築でも引き継ぐ。
- `withLcamSession`: Cookie が無ければ資格情報でログイン。失効を検知したら、KV の Cookie が他のリクエストで更新済みならそれを採用し、そうでなければ
  再ログインして op を **1 回だけ**再試行。再ログイン後も失効なら諦める。資格情報が拒否されたら `lcamApp` を破棄して再登録を求める
  （拒否を繰り返さない）。上流のログイン制限（`stop_login`）は資格情報を捨てずに 502 として返す。
- 並行リクエストの直列化はしない。同時に失効を検知した複数リクエストが、互いのセッションを奪い合う可能性がある（既知の制限。後から来たリクエストは
  KV の新しい Cookie を採用するため、1 回の再ログインに収束する見込み。未実測）。
- API: `POST /api/lcam/session` に `{appKey}`（既存の `{cookies}` も可）、`POST /api/lcam/session/revoke`（DELETE ではなく POST。CORS と Tauri の
  `api_request` が GET/POST のみのため）、`GET` に `appRegistered`（`registered` は Cookie または資格情報がある場合に true）。MCP `lcam_set_session` は `appKey` にも対応。
- Web「その他 → LCAM 連携」: URL 貼り付け登録・状態表示・登録解除。Tauri `lcam_login.rs`: SP 経路（モバイル UA）を WebView で開き、
  `on_navigation` で `lamyapp://` を傍受して `appKey` として登録（**実機での傍受は未検証**）。
- `lamyapp://` の URL・key・アプリ用トークンはログ・エラー文言に出さない（テストで確認）。

### 15.7 残る未確認事項

- Tauri（Windows の WebView2 / macOS の WKWebView / iOS）で `lamyapp://` への遷移が `on_navigation` に届くか。
- `key` の有効期限（使い捨てか、何分で失効するか）。実測では取得直後に交換して成功した。
- アプリ用トークン（`password`）の有効期間（失効したら 424 で再登録を求める）。
- `smartPhoneLogin/` 失敗時の実応答（アプリのコード上は JSON `{status:'fail'}`。実応答は未観測。未観測のため、ログイン後の SP 時間割の
  確認（`probeSpSession`）でも失効として扱い、資格情報の拒否と判定する）。
- 本番（relay 経由）での `spAppLogin/` / `smartPhoneLogin/`: **確認済み（2026-09-25）**。`tauri dev` を本番の Worker に向けて（ユーザー報告）
  key を登録でき、本番のリモート MCP から時間割を取得できた（relay が `Set-Cookie` を返し、資格情報の保存と再利用が動いた）。

未確認・未対応・要修正の項目は `docs/BACKLOG.md` に一覧を置く。

## 16. スケジュール（個人スケジュール）・授業アンケート・課題の提出状況の画面反映（2026-09-25）

### 16.1 実測（PC ホームの個人スケジュール。ユーザーが内蔵ブラウザで PC 画面ログインした状態を観察。読み取りのみ）

- ログイン直後の PC ホームは `GET /portalv2/login/login/initLogin/sso`（SAML の戻り先）で描画される。週表示のカレンダー
  `table.calendar-body`（今日が先頭列の 7 日間）が含まれ、既存の `parseSchedule`（Dart 由来）で実 HTML を正しく解析できた。
- 表記: 授業は `Ⅰ限(09:00-10:30)` / `[八]科目(クラス)` / 教員（複数は末尾「他」）/ `八草 教室` の 4 行。**6 限（`Ⅵ限`）がある**
  ため、旧パーサ（Ⅰ〜Ⅴ のみ）は落としていた。行事は 1 行（例: `履修登録(終了)`）。**休講・補講の表記は未観測**
  （授業の 4 行に追加行が付くのか、別の予定になるのかは実データが要る）。
- 週送り（PC 画面の JS `chengeSchedule`）: `POST /portalv2/schedule/scheduleForHome/getSchedule`（`_mode`=2 前月 / 3 前週 /
  4 今日 / 5 翌週 / 6 翌月、`EXCLUDE_SET=`）は **token 不要**。サーバー側のセッションに表示位置が残り、続けて
  `POST /portalv2/home/home/reload`（`TOKEN`, `_screenIdentifier=home`, `_screenInfoDisp=`, `_scrollTop=148`）で再描画する。
  ページ内の全フォームの `org.apache.struts.taglib.html.TOKEN` は同じ値（セッション単位の 1 値）。
- PC ホームのメニューは `POST /portalv2/common/generalPurpose/`（`headTitle`/`menuCode`/`nextPath` と TOKEN）で遷移する。
  これに token 無しの GET をすると「不正な操作」でセッションが破棄される（§14.4）。これが SP 側で「PC 画面に触れない」理由の
  実体は、PC 画面が悪いのではなく **token の無いリクエスト**だった可能性が高い（下の仮説）。

### 16.2 実装（`/api/schedule?weeks=`。実 LCAM で動作確認済み: 2026-09-25）

- **入口は PC のメニュー「ホーム」と同じ `POST /portalv2/common/generalPurpose/`**（`TOKEN`, `headTitle=`（空）, `menuCode=Z07`,
  `nextPath=/home/home/initialize`）。token は認証済みの SP ページ（SP 時間割）のもので通る。SP（アプリ方式）セッションのままで
  PC ホーム（約 60 KB、週表示カレンダー付き）が返り、**その後も同じセッションで SP 時間割が取得できた**（セッションは壊れない）。
- 当初の実装（`home/home/reload` を最初に POST）は、「システムエラーにより利用を継続することができなくなりました」の 716 バイトの
  ページになり失敗した。PC ホームの初期化（generalPurpose 経由）が要る。§14.4 の「不正な操作」は token 無しの GET が原因だった。
- `fetchSchedule`（`worker/src/upstream/lcam/client.ts`）: SP 時間割 GET で token → `generalPurpose`（PC ホームを開く）→
  `getSchedule(_mode=4)` で表示位置を今日に揃える → 週ごとに `reload`（解析）→ `getSchedule(_mode=5)`。週数は 1〜12
  （subrequest 50 を守るため）。実測: 8 週で 1.75 秒。
- 拒否・想定外の応答（「不正な操作」「システムエラー」）は `LcamExpiredError` ではなく **`UpstreamError`（502）**。`LcamExpiredError` にすると
  `withLcamSession` が再ログインを繰り返す・失効と誤記録するため。
- **広い範囲の取得（月送り）**: `getSchedule` の `_mode=6`（翌月）/`2`（前月）は、「今月から ±1 か月ずつ、その月の 1 日を含む週（月曜始まり）」
  へ飛ぶ（実測: 9/25 から翌月→9/28..10/4、さらに翌月→10/26..11/1。前月方向も同様）。`/api/schedule?month=N&weeks=W` は、今日に揃えたあと
  月送りして W 週を取る（`month=0` は前月→翌月で今月の 1 日を含む週）。1 リクエストで動かせる回数は subrequest 50 が上限のため
  （月送り |N| 回 + 2W + 3 ≦ 約 40）、W は最大 14、|N| は最大 8。Web はカレンダーの表示範囲（今月の前後 6 か月）を、
  `month` = 0 / 3 / -3 / 6（6 週）/ -6 の 5 チャンクに分けて順に取る。実測: 各 1.7〜3.5 秒、**2026/2/23〜2027/4/11 の 413 日を欠けなく取得**。
- 実データ: 授業以外の予定として `履修登録(開始/終了)`・`履修取消(開始/終了)`・`大学祭`・`スポーツの日`・`文化の日`（＋`授業実施日`）・`入学式`・
  `卒業式`・`期末試験`・`期末試験時間割発表`・`成績発表・発送`・`オープンキャンパス`・`愛名会企業研究会`・`年末年始`・`臨時休業日` など。
  **休講の実際の表記**は、印だけの 1 行 `【休講】` + 授業の 3 行（`Ⅴ限(16:20-17:50)` / `教育原論(X1)` / `川口　洋誉　他`。教室の行なし）で、
  通常の授業の代わりにその日に出る（授業の行は残らない）。→ `period` つきの授業として `note: '休講'` を付ける。補講は未観測
  （印が `【補講】` になる想定で同じ扱い）。休日の授業実施は `授業実施日` という終日の予定で出る。
- `parseSchedule` の修正: 6 限対応（時刻は行のテキストから取る）、休講など印つき・教室なしの授業、想定外の行数は捨てずに `note` に残す、
  形が未知の複数行は連結した終日予定として残す（旧実装は捨てていた）、年は基準日に最も近い年（過去の月でもずれない）。テスト: `worker/test/lcam-schedule.test.ts`。
- Web: `web/src/lib/stores/schedule.svelte.ts`（localStorage キャッシュ。6 時間より古いときだけ取り直し、失敗後は 10 分は自動で
  再取得しない。チャンクごとに 1 回だけ再試行（LCAM は他の呼び出しと重なると一時的に 500 を返すことがある）。常にキャッシュから表示）。カレンダーは、取得範囲内の日は授業をスケジュール（補講・休講の反映済み）から、範囲外は曜日ごとの
  時間割から出し、授業以外の予定を「学校の予定」欄とドットで表示する。

### 16.3 授業アンケート（お知らせへの反映）

- 既存の `GET /api/enquetes?type=class`（一覧・参照のみ）を Web に接続。お知らせ画面に「アンケート」タブ（未回答数のバッジ）、
  ホームの「最近のお知らせ」に未回答のアンケートを表示する。回答・提出は Web には実装しない（MCP / L-Cam から）。
- 一覧の項目は `授業科目`/`タイトル`/`状態`/`提出期間`/`提出状況`（§10.2 で実データ確認済み）。値の語彙（未提出・受付中など）は
  観測が少ないため、判定は保守的な部分一致（`web/src/lib/enquete.ts`）。未知の語彙は「未回答」と決めつけず、詳細に生の値を出す。
- 実データ確認: 2026-09-25 時点、このアカウントのアンケートは 0 件（画面はダミー API で確認）。**実データでの語彙の確認は未実施**。

### 16.4 お知らせ・アンケートのクライアントキャッシュ

- 背景: 一覧 1 回で LCAM へ直列 3 リクエスト（Struts TOKEN チェーン）、詳細は 4 リクエストかかり、起動・タブ切替のたびに待たされていた。
- 実装: `web/src/lib/stores/notices.svelte.ts`（localStorage `aitapp.notices.v1`、`schedule.svelte.ts` と同方式）。Worker 側の変更なし。
  - 一覧・アンケートはキャッシュから即表示し、裏で取り直す。キャッシュが無いときだけ読み込み表示。「もっと見る」の件数も保存する。
  - 詳細は `type|sender|title|日付` をキーに最新 50 件を保持。詳細取得は一覧上の index を使うため、一覧が 5 分より古ければ一覧を取り直して index を引き直す（新着による位置ずれ対策）。
  - 同種別の多重取得は in-flight を共有。30 秒以内に取得済みの種別は取り直さない。LCAM は呼び出しが重なると失敗し得るため、種別は直列に取る。
  - userId に紐づけ、ログアウトで削除。
- Worker（KV / Cache API）に置かない理由: KV は無料枠の書き込み 1000/日を節約する設計で、ユーザーごとの一覧キャッシュを載せられない。クライアント側なら browser / Tauri / mobile のすべてで効く。
- **実機確認は未実施**（2 回目以降の起動・タブ切替でスピナーが出ない／件数が保たれる／開いた詳細が即表示／ログアウトでキー削除）。

### 16.4 Moodle 課題の提出状況

- `GET /api/moodle/assignment/status` に `assignmentIds=1,2,3` を追加（指定した課題だけ・期限切れも含む）。1 回 20 件まで
  （課題 1 件 1 subrequest のため。既存の上限）。Web は表示中の課題の先頭から 15 件ずつ取得し、提出済み・下書き・未提出・
  再提出待ち・採点済みをバッジ表示する。Moodle で提出済みの課題は「これから」から外れる。
- 実データ確認（2026-09-25）: 本物の Moodle（cms.aitech.ac.jp）で課題 72 件、`assignmentIds` 15 件ずつの提出状況を全件取得できた
  （提出済み 71・未提出 1）。**ローカルの Worker が `.dev.vars` の `MOODLE_ORIGIN_OVERRIDE` でサンドボックス（コース `test` のみ）に
  固定されていると課題が 0 件に見える**（本物を見るときはこの行を外す／`cms.aitech.ac.jp` にして再起動）。画面はダミー API でも確認。

## 17. LCAM PC 版の参照機能（2026-09-25。docs/LCAM_FEATURES.md の実装）

PC 版の画面（Struts）を Worker から読む機能を追加した。**いずれも「ユーザーが内蔵ブラウザで入った実 LCAM」で、Worker と同じ手順の
POST を再現して確認した**（Worker からの実行は未検証。§17.5）。

### 17.1 PC 画面の入り方（`worker/src/upstream/lcam/pc.ts`）

- 入口: SP 時間割の GET から Struts token を得る → `POST /portalv2/common/generalPurpose/`（TOKEN・`headTitle`（空でよい）・`menuCode`・
  `nextPath`）でメニューを開く。以降はそのページのフォームを POST し、**応答の token を次に使う**。
- **token は使い捨て**。使用済みの token を再送すると「不正な操作」（題「総合ポータルシステム」）になり、**LCAM セッションが破棄される**
  （調査中に自分で踏んだ）。Worker は 1 リクエストの中で直列にたどる。`assertPcPage` は「不正な操作」を `UpstreamError`
  （再ログインを繰り返さない）、ログイン画面を `LcamExpiredError` にする。
- 検索フォームは「画面の初期値 + 指定した項目だけ上書き」で送る（`formDefaults`）。詳細への遷移などは TOKEN + 最小の項目で通った。
- ダウンロード（`fileDownLoad2/…`）は token 検査の対象外（画面が `EXCLUDE_SET` を付ける）。フォームの項目を POST するとファイルが返る。

### 17.2 機能ごとの遷移（メニューコード → 確認した POST）

| 機能 | menuCode / nextPath | 確認した遷移 |
|------|---------------------|--------------|
| 学内共有ファイル | B08 `/commonfile/commonFile/initialize` | 詳細 `commonFileDetail/initialize`（TOKEN, `hiddenCommonFileId`, `prevPageId`）→ 添付 `commonFileDetail/fileDownLoad2/…` |
| レポート | A02 `/report/student/searchList/initialize` | 検索 `searchList/search`（`schoolYear`, `semesterCode`, `operationFormat`×2 [, `submitStatus=0`]）→ 参照 `searchList/forwardSubmitRef`（TOKEN, `reportId`）→ 提出履歴のファイル `submitReportReference/fileDownload?EXCLUDE_SET=`（参照画面のフォームの項目 + `studentCode`/`submitNo`/`fileNo`） |
| 施設 | B03 `/facilityresv/facilityInfoSelect/initialize` | 表示 `facilityInfoSelect/checkInput`（`checkArray` に施設コード。複数可。選んだ順に行が並ぶ）→ 週送り `facilityResvRefWeek/reload`（`dayMoveDivision` 3=前週 4=今日 5=翌週） |
| 学内連絡 | B01 `/commoncontact/commonContact/initialize` | 検索 `commonContactRcvList/searchCommoncontactRcvList` → 詳細 `commonContact/dtlEdit`（`mode=initializeRcv`, `selectIndex`, `commonContactId`, `commonContactKindDivision`）→ 添付 `common/fileUploadDownload/fileDownLoad2/…`（詳細の `common_fileUpload` フォームの項目） |
| 授業連絡 | A01 `/classcontact/classContactList/initialize` | 検索 `classContactList/selectClassContactList` → 詳細 `classContactList/goDetail/{行番号}`（TOKEN のみ。一覧はセッションが持つ）→ 添付は学内連絡と同じ |
| 学事システム | 下記 | 下記 |

- 添付の詳細画面の onclick は名前が `\uXXXX` エスケープ（`decodeJsEscapes`）。

### 17.3 学事システム（`kyoumu.ts`）

- ホーム（Z07）の `home_systemCooperationLink` フォームの token で `POST /portalv2/home/systemCooperationLink/initialize?renkeiType=kyoumu`
  → 自動送信フォーム（`/kyoumu/portalRedirect.do;JSESSIONID=…`, hidden `loginID`）→ その action へ `loginID` を POST → メニュー（`dbLinkClick('/kyoumu/…')`
  のリンク 16 個）。以降は GET。
- **URL の jsessionid だけでは 500**（実測。Cookie なしで 500、Cookie ありで 200）。引き渡し応答の Set-Cookie（学事システムの JSESSIONID）を保持して送る。
  LCAM 本体の JSESSIONID は送らない（同名で衝突）。応答は基本 UTF-8、エラー画面は Shift_JIS。
- 表は入れ子のレイアウト表。実データを持つのは入れ子のない `table.txt12`（カリキュラム 182×6、単位修得 24×13、抽選結果は曜日時限ごとに複数）。
  単位修得は rowspan/colspan の階層表で、展開すると 13 列の規則的な表になる（実 HTML で確認）。
- 学内スケジュールの月切替は GET（`?actionStatus=change&changeTarget=month&targetMonth=N`）。年度切替（`targetNendo=prev|next`）は未対応。

### 17.4 API（`worker/src/routes-pc.ts`）

`/api/commonfiles`(+`/detail`,`/download`) / `/api/reports`(+`/detail`,`/download`) / `/api/facilities`(+`/schedule`) /
`/api/pcnotices`(+`/detail`,`/file`。kind=campus|class) / `/api/credits` / `/api/curriculum` / `/api/schoolevents` / `/api/lottery`。
いずれも参照のみ。MCP のツールと web の「その他 → 学内サービス」に対応する。

### 17.5 未検証・要観測

- **（§17.6 でローカルの Worker → LCAM 直続の実行は確認済み。以下は relay 経由・本番についての未検証）** **Worker（relay 経由）からの実行は未検証**。特に学事システムの Cookie の受け渡し（relay が複数の Set-Cookie を返すか）と、
  PC 画面へ SP セッションから入ることの副作用（`/api/schedule` と同じ既知の性質: SP 側 Cookie が失効することがある）。
- 実データが 0 件で構造を見られていないもの: 提出期間中のレポートの提出画面、評価結果の節（`h3 評価結果` 以降の形）、返信可の連絡、
  授業評価アンケート・トピック・FAQ・オフィスアワーの中身。レポートの「参考資料」のファイル取得は未対応（表記のみ）。
- 一覧が長い場合: 学内連絡は既定で 105 行が 1 ページに出る（ページングの操作は不要だった）。授業連絡・施設も同様。
- **並行リクエストのリスク（§17.6 で実測。以下は当初の想定）**: Struts の token は使い捨てで、PC 画面の遷移は「直前の応答の token」を順に渡す。同じ LCAM セッションで
  PC 画面の操作が同時に走ると、互いの token を無効にして「不正な操作」→ セッション破棄になり得る（SP 画面の token も同じ
  セッションの持ち物と推測。`CLAUDE.md` の制約により並行の直列化はしていない）。画面側は 1 画面内で PC 系のリクエストを順に投げ、
  MCP からは PC 系ツールを並列に呼ばない。破棄された場合は、次のリクエストが透過再ログインで復帰する。

### 17.6 実データでの確認（2026-09-25。ローカルの Worker → LCAM 直続。relay なし）

サンドボックス用 Worker（:8788）に、本人の `lamyapp://` key を登録して実行した。すべて参照のみ・直列。
**relay 経由（本番 Worker）は未確認。** 提出・登録・取消・ログアウトは行っていない。

**動作確認できたもの**: 学内共有ファイル（一覧・詳細・ダウンロード。PDF の先頭バイトを確認）、レポート（一覧・詳細・提出履歴のファイルは JPEG が取れた）、
施設（一覧・週の使用状況）、学内連絡・授業連絡（検索・詳細・添付。添付は PDF）、教職員スケジュール（氏名検索・週間）、
学事システム（単位修得情報・カリキュラム・抽選履修登録結果・学内スケジュール）。

**実測で見つかった不具合と修正**:

1. **学事システムのメニューが空**（`openKyoumu` が全滅。502）。アプリ方式のセッションでは、引き渡しの POST
   （`/kyoumu/portalRedirect.do;JSESSIONID=…`）が**本文の無い 200 と、学事システムの Cookie（`JSESSIONID`。
   `SameSite=None; Secure`）だけ**を返す（PC 画面ログインのときはメニューが返った）。Cookie ヘッダ・UA・Referer・Sec-Fetch を
   変えても同じ。その Cookie で各画面（`taniShuutokuJouhouSearchInit.do` など）を直接 GET すると取れる。
   → 本文が空で Cookie があるときは、docs/LCAM_FEATURES.md のメニューコードから作った既定のリンクを使う（`kyoumu.ts` の `DEFAULT_LINKS`）。
   `;JSESSIONID=` を URL から外す・小文字にすると、エラー画面（「L-Cam Web System エラー」）になる。
2. **学内スケジュールの月切替**: 通常の表示を先に 1 回 GET しないと、`actionStatus=change&changeTarget=month` が別の画面
   （年度が出ない）を返す。上流が画面の状態をセッションに持つ。→ 先に通常表示を GET して年度を取ってから月を切り替える。
3. **学内共有ファイル一覧の列ずれ**: 実 HTML は先頭に空の列、末尾に並べ替え用の 2 列があり、`size` と `updatedAt` が入れ替わって
   （DL 数が 1 つずれて）返っていた。→ 見出し（`カテゴリ（タグ）`/`タイトル`/`DL数`/`サイズ`/`更新日時`）の位置から列を決める。
   合成 HTML のテストも実物の構造に直した。
4. **学事システムを開く導線（`/api/open/kyoumu`）が空白ページになる**（1 と同じ原因。内蔵ブラウザで確認）。
   → POST を非表示の iframe に向け、Cookie が入ったら着地先の画面へ移動する。`?to=register|cancel|lottery`（履修登録 / 履修取消 /
   抽選履修登録。`/kyoumu/rishuuCheckInit.do?mainMenuCode=002` など。実ブラウザで表示できることを確認）。Web の「本家で行う操作」も 3 画面に分けた。
   学籍情報の更新の画面は確認できていないため許可リストに入れていない（BACKLOG）。iframe 内の Cookie は Safari のサードパーティ Cookie 制限で拒否され得る（未検証）。
5. **並行リクエストで資格情報が消える**（重大）。PC 画面の API を 4 本同時に投げると、1 本だけ成功し、3 本が
   `reauth_required`（失効）になり、**保存済みのアプリ用資格情報（`lcamApp`）まで削除された**（`appRegistered:false`。key の再登録が必要になった）。
   原因: LCAM は単一セッションで、再ログインが互いのセッションを無効にする。ログイン直後の確認（`probeSpSession`）が失効を検知すると、
   `appLogin` は `LcamAppCredentialRejectedError`（資格情報の拒否）を投げ、`reloginWithApp` が `lcamApp` を消していた。
   → 確認での失効は `UpstreamError`（一時的な失敗。502）にして、資格情報を消さない。資格情報の拒否は `status=fail` と `JSESSIONID` 無しだけ。
   **直列化はしていない**（`CLAUDE.md` の制約）。並行で失敗するリクエスト自体は残るため、画面は PC 系を順に投げる・MCP は PC 系を並列に呼ばない運用のまま。
   **修正後の再測定（同日、新しい key）**: 同じ 4 並行を 3 ラウンド。毎回 2 本前後が 502（`LCAM http error: statusCode=500`、または一覧画面を認識できない）
   で失敗したが、**資格情報とセッションは維持**され（`appRegistered:true`）、直後の直列の 4 リクエストは全件成功した。
   並行で token を潰し合うこと自体は残る（直列化しない方針のため）。失敗は 424（再登録）ではなく 502 で、次のリクエストで復帰する。

**確認した結果として変わらないもの**: 実データが 0 件のもの（提出期間中のレポートの提出画面・評価結果・返信可の連絡・授業評価アンケートなど）は、
引き続き構造を見られていない。

**デスクトップ版でファイルを開く**: 上記とは別に、Tauri の `openPath` が `opener.open_path not allowed`（権限 `opener:allow-open-path` が無い）で
失敗していた。既定ブラウザで開く方式に変更した（`tauri/src-tauri/src/browser_open.rs`。BACKLOG）。

## 18. Tauri 版で「不可逆操作を許可」チェックボックスが編集できない不具合の修正（2026-09-29）

- **症状**: `web/src/lib/views/More.svelte` の「不可逆操作を許可」チェックボックスが、Tauri（デスクトップ）版で常に `disabled` になり操作できない。
- **原因**: `web/src/lib/api.desktop.ts` の `me()` が `restore_session`（Rust の keyring 復元）の戻り値 `userId` のみを返し、
  ブラウザ版の `me()`（`GET /api/auth/me`）が返す `mcp` / `mcpWrites` を返していなかった。`More.svelte` はこの2つが無いと
  チェックボックスを `mcpWrites === undefined` として無効化する。
- **修正**: `restore_session` で Rust 側のセッション（cookie jar）を復元したあと、`call('/api/auth/me')`（`api_request` invoke 経由、
  Worker の `/api/auth/me` を叩く）を呼び、`mcp` / `mcpWrites` を含む応答をそのまま返すよう変更した（`api.desktop.ts`）。
  Worker 側（`POST /api/auth/mcp-writes`、`state.mcpAllowWrites`）は変更していない。ブラウザ版は元々 `/api/auth/me` を直接叩いており対象外。
- **確認**: `web/` で `bun run check`（`svelte-kit sync && svelte-check`）が 0 エラー・0 警告で通過。Tauri 実機での動作は未確認
  （`tauri dev` でチェックボックスが操作可能になることの確認が要る。`docs/BACKLOG.md` から本項目は削除）。
