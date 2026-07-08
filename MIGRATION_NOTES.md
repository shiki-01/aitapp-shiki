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
- KV 書き込み 1,000/日 を浪費しないよう、書き込みは「ログイン時」「上流 cookie 更新（再ログイン時）」「moodle token 更新時」のみ。データ取得（notices/timetable/syllabus）では書き込まない。
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
