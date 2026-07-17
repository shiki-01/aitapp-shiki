# 上流観測バックログ台帳（Issue #19 / B2 vendor/aitapp 照合）

作成日: 2026-07-16 / 対象コミット: `origin/main`（本ブランチ `claude/issue-19-verification-ledger`）

## 位置づけ（重要）

本書は **未確定の観測課題を構造化して記録する台帳** である。ここに並ぶ項目は
`docs/CODE_REVIEW_2026-07-13.md`（36+9 エージェントの静的解析）で挙がった懸念のうち、
**実バグと断定できず「実サーバの実 HTML／実レスポンスを観測してから対応可否を判断する」もの**を抜き出したもの。

- 本書では **アプリケーションコードを一切変更しない**（ドキュメント専用）。
- 上流 URL・パラメータ・レスポンス形状を **推測で補完しない**（CLAUDE.md 大原則）。
- 各行の「判定」は **静的読解のみで到達できる確度**であり、`要検証` は「実観測なしに実バグと断定も棄却もできない」ことを意味する。

判定語彙:
- `要検証` … 実 HTTP 観測が無いと真偽を決められない。
- `実バグ確度[低/中/高]` … 静的に見てバグの蓋然性がどの程度か（観測前の暫定）。
- `問題なし` … 静的読解で懸念が棄却できる。

---

## B2: vendor/aitapp サブモジュール照合ステータス（「Dartから取る」大原則の検証可否）

| 項目 | 結果 |
|---|---|
| `.gitmodules` の登録 | あり。path=`vendor/aitapp`、url=`https://github.com/ROTO0504/aitapp.git` |
| `git submodule update --init vendor/aitapp` の実行結果 | **失敗**。`fatal: could not read Password for 'http://local_proxy@127.0.0.1:...': terminal prompts disabled` → 2 回リトライ後 abort。ネットワーク/認証がこの隔離環境から通らないため clone 不可。 |
| サブモジュール状態 | 未チェックアウト（`git submodule status` が `-33918fe... vendor/aitapp` = 先頭 `-`）。`vendor/aitapp/` は空ディレクトリ。 |
| コミットへの影響 | サブモジュールポインタは **変更していない**（何も取得できていないため）。本ブランチはドキュメント追加のみ。 |

**結論（B2）**: 本環境では **Dart 実装（移植元）との直接照合は現時点でも不能**。したがって
CLAUDE.md／REQUIREMENTS.md の大原則「上流の URL・パラメータは Dart 実装から取る／推測で補完しない」の
**忠実性は一度も機械的に検証できていない**（CODE_REVIEW 第5弾 B2 と同じ状態が継続）。
本台帳の「移植元Dartの事実」列はすべて `要submodule照合` とし、根拠は `MIGRATION_NOTES.md` の
記述（＝Dart を読んだ人間のメモ、一次ソースそのものではない）に留まる。

> 照合を可能にするには、ネットワーク/認証が通る環境で `git submodule update --init vendor/aitapp`
> を成功させ、`vendor/aitapp/lib/infrastructure/restaccess/` 配下（`access_lcan.dart` /
> `get_lcam_data.dart` / `lcam_parse.dart` / `access_moodle.dart` / `access_syllabus.dart` /
> `syllabus_parse.dart` 等）を各 TS 実装と突き合わせること。

---

## 台帳本体

各行: **現状** / **移植元Dartの事実** / **リスク** / **検証方法** / **判定**。

### A1: 成績「評価済み科目」の評点が未観測（評点の誤表示リスク）

- **現状**:
  `worker/src/upstream/lcam/parse.ts` `parsePerformance()`（L328-374）。`td.txt12` を走査し、
  1行＝カテゴリ見出し（`【…】` を剥がす）、複数行＝科目行として扱う。科目行は先頭 `※`＝履修中
  （`inProgress`）、以降を **ラベル正規表現**で判定: `^教員`、`^\d{4}年度$`、`前期|後期`、
  `^単位\s*:`、`^評価\s*:`。`評価 : ` にマッチした残り（`line.replace(/^評価\s*:\s*/,'')`）が `grade`。
  ラベルのどれにも当たらず `subject===''` の最初の行を科目名に採用する（ヒューリスティック）。
  固定インデックス依存ではないため、位置ずれには強い。
- **移植元Dartの事実**: `要submodule照合`。MIGRATION_NOTES §10.1 は「Dart 実装に対応機能なし
  （`webAccessLinks` は WebView 表示のみで未パース）」と明記。すなわち **移植元が存在しない新規実装**で、
  照合しても Dart 側に正解パーサは無い（＝Dart 準拠性は論点にならない。実 HTML が唯一の正解源）。
- **リスク**:
  1. テストアカウント（1年生・全科目履修中）では **評点が入った行を一度も観測していない**（§10.1・§273-274）。
     評価済み行のレイアウトが未修得行と異なる可能性（例: `評価 :` の値が `優/良/可/不可/秀`、GPA、
     素点、あるいは別セル/別ラベルで来る）があり、その場合 **grade が空になる / 別フィールドに化ける**。
  2. 科目名ヒューリスティック（「ラベルに当たらない最初の行」）は、**科目名が偶然ラベル語
     （例: 科目名に「前期」を含む）だと科目名が欠落**しうる（CODE_REVIEW 第4弾で既指摘）。
- **検証方法**: 評価済み科目を持つアカウント（上級学年・単位取得済み）で
  `GET /portalv2/smartphone/smartPhonePerformanceInfor/nextPage/performance/` の実 HTML を採取し、
  評価済み行の `td.txt12` 内テキスト行構造を確認。特に (a) 評点値の文字種と `評価 :` ラベルの有無、
  (b) 単位数が評価済みで変わるか、(c) 科目名行がラベル語と衝突しないか、を実データで確認する。
- **判定**: `要検証`（実バグ確度[低〜中]）。パース方式はラベル抽出で堅牢寄りだが、評価済み行の
  実レイアウトが未観測である以上「評点の誤表示なし」を断定できない。断定には評価済み実 HTML が必須。

### A4: アンケート回答の失敗レスポンスが未観測（失敗を成功と誤判定＝誤送信/未送信の隠蔽）

- **現状**:
  成否判定は `worker/src/upstream/lcam/client.ts` `looksLikeSuccess()`（L242-246）:
  `parseHtml(html).querySelectorAll('#_errorInformation > ul > li:nth-child(1)').length === 0`
  ＝ **エラー要素が無ければ成功**（fail-open）。これを `submitEnqueteAnswer`（tempSave, L257-265）と
  `finalizeEnqueteAnswer`（confirm→finalize, L279-302）の戻り `{ ok }` に使う。
  送信経路は `worker/src/upstream/lcam/access.ts`: `postEnqueteTempSave`(L376) /
  `postEnqueteConfirm`(L412) / `postEnqueteFinalize`(L454)。いずれも `httpAccess` が **200 以外を例外**にし、
  200 本文を `looksLikeSuccess` に渡す。finalize では途中で `assertSpSessionAlive` / `parseEnqueteConfirm` /
  `extractStrutsTokenByForm` を挟むが、最終 `postEnqueteFinalize` の戻り本文は `looksLikeSuccess` のみで判定。
- **移植元Dartの事実**: `要submodule照合`。MIGRATION_NOTES §11 は「授業アンケート回答は **Dart 実装に対応機能なし**、
  ユーザー許可のもと実データで **一時保存(tempSave) のみ検証済み**、最終提出フロー（confirm→finalize）は
  実機再現でフォーム名/遷移先を確認・修正」とする。**Dart に移植元は無い**＝照合対象は実 HTML のみ。
- **リスク**:
  1. `looksLikeSuccess` は **肯定的な成功マーカーを見ておらず**、`#_errorInformation` という
     **単一の失敗マーカーの不在**に依存。上流の失敗表現が別 ID/別文言/別画面（例: 期間外・二重提出・
     セッション喪失で入力画面に差し戻し・バリデーションを JS 側で出す等）だと **失敗を `ok:true` と誤報告**。
  2. とくに finalize は **不可逆な本登録**。誤って成功と返すと、ユーザー/LLM は「提出済み」と誤認し、
     実際は未送信のまま締切徒過、あるいは逆に想定外送信が成立したのに検知できない
     （CODE_REVIEW S5「常に ok:true」・S8「enquete-final が唯一の二重提出リスク経路（要検証）」と同根）。
  3. `#_errorInformation > ul > li:nth-child(1)` の `:nth-child` セレクタが node-html-parser で
     期待どおり効くか自体も別途未確認（CODE_REVIEW #6 が detect の同型セレクタで指摘）。
- **検証方法**: ユーザー許可の下で **意図的に失敗する回答**（期間外アンケート・必須未入力・
  文字数超過・二重提出・セッション切れ）を送り、`tempSaveAction` / `confirmAction` /
  `smartPhoneClassEnqAnswerConfirm/confirmAction` の **失敗時 200 本文**を採取。失敗画面に
  `#_errorInformation > ul > li` が実際に現れるか、成功画面に肯定マーカー（完了メッセージ等）が
  あるかを確認し、fail-open を fail-closed（肯定マーカー必須）に寄せられるか判断する。
- **判定**: `要検証`（実バグ確度[中]）。失敗レスポンス未観測での fail-open 判定は誤報告の余地が構造的にあり、
  かつ finalize が不可逆であることからリスクは中。実バグと断定するには失敗時実 HTML が必須。

### A2 / §3.5: `detect.ts` が実ログインページ HTML 未観測のヒューリスティック

- **現状**:
  `worker/src/upstream/lcam/detect.ts` `looksLikeLoginPage()`（L12-23）: 小文字化した生 HTML に
  `name="userid"`（または `'userid'`）**かつ** `name="password"` **かつ**
  （`smartphonelogin` | `/login/login/` | `prelogin`）が **すべて**含まれるときのみ失効とみなす（保守的 AND 条件）。
  併せて認証済み SP ページ判定は `assertSpSessionAlive()`（client.ts L68-72）＝
  本文に `org.apache.struts.taglib.html.TOKEN` が無ければ失効、という **別系統の生存判定**も使う
  （§9.4 の「単一セッション相互無効化で返る ~720byte スタブ」はログインフォームでないため
  `looksLikeLoginPage` では捕まえられず、こちらの TOKEN 不在判定で拾う設計）。
  なお `isLoginSuccess()`（L26-31）は **fail-open**（`#_errorInformation` 不在＝成功）で、A4 と同型。
- **移植元Dartの事実**: `要submodule照合`。MIGRATION_NOTES §3.5 は「実ログインページ HTML **未観測**の
  ヒューリスティック。SP ログインフォームの marker（`name="userID"` + `name="password"` +
  `smartPhoneLogin`/`preLogin`）で `true` になることは **ローカル未認証検証で確認済み**、
  実際のログインページ観測後にシグナル精緻化」とする。Dart の `lcam_parse.dart` の `isLogin`
  （`#_errorInformation > ul > li:nth-child(1)` 空なら成功）を流用した旨の記述あり＝照合価値あり。
- **リスク**:
  1. **過剰検知**（false positive）: 通常データページに 3 条件が偶然揃うと不要な再ログインが走る
     → KV write 増幅・単一セッション無効化の連鎖（CODE_REVIEW 連鎖A）。AND 条件で確度は上げてある。
  2. **見逃し**（false negative）: 実ログインページの input 名や action が想定と異なる
     （`name="userID"` の大小/別名、action が `preLogin` 以外、MFA 画面等）と失効を検知できず、
     ログイン HTML を正データとしてパースし NotFoundError や誤データに化ける。
     とくに MFA 導入時はここが破綻点（CLAUDE.md「検知してエラーを返す分岐だけ用意」）。
  3. 生 HTML の文字列 `includes` 判定のため、属性順・クオート種・大文字化には `toLowerCase` で
     ある程度耐えるが、`name = "userID"`（スペース入り）等の表記ゆれには弱い。
- **検証方法**: 実際に失効した状態で各 SP エンドポイントを叩き、返るログイン/スタブ HTML を採取。
  (a) ログインフォームの実 input `name` と form action、(b) §9.4 スタブの実バイト列と TOKEN 不在、
  (c) MFA 画面の形、を確認し、marker を実 DOM に合わせて精緻化する。
- **判定**: `要検証`（実バグ確度[低]）。保守的 AND ＋ TOKEN 不在の二段構えで大崩れはしにくいが、
  「実ログインページ HTML 未観測」である以上、marker の網羅性は原理的に未保証。設計上も §3.5 が
  「観測後に精緻化」と明言しており、実 HTML 採取が前提。

### 時間割 TOKEN 生存判定前提 / schedule の PC ログインが SP セッションを無効化（連鎖A起点）

- **現状（TOKEN 生存判定）**:
  `fetchTimetable()`（client.ts L119-125）は `getClassTimeTableBody`（access.ts L485-498、
  `GET .../smartPhoneHome/nextPage/timeTable`、token 不要）取得後に `assertSpSessionAlive(body)`＝
  **本文に `org.apache.struts.taglib.html.TOKEN` が無ければ `LcamExpiredError`**。同判定は
  performance / enquete 系でも共通利用。パースは `parseClassTimeTable()`（parse.ts L597-660）で、
  上流の閉じ忘れ `<div class="kamokuDetailLink">` を `closeKamokuDivs` で補正し、壊れページでは
  `extractBalancedTable` で `table.jikanwari` を局所抽出するフォールバックを持つ。
- **現状（schedule の相互無効化）**:
  `fetchSchedule()`（client.ts L309-344）は毎回 `pcGetCookie → preAccess → initLogin → reload×weeks`
  の **PC ログインフロー**でステートレスに取得（透過再ログインのラップ対象外）。MIGRATION_NOTES §9.4 の
  「ユーザーあたり単一セッション」により、この PC ログインは **KV 保存済みの SP cookie を上流側で無効化**する。
  次の notices/timetable は SP セッション喪失 → `assertSpSessionAlive` が TOKEN 不在を検知 → 透過再ログイン
  （KV write）で自動復帰、という設計（§9.4 対応）。schedule 自体はループ内で `parseSchedule` 失敗時 `break`
  する部分成功切り詰めを持つ。
- **移植元Dartの事実**: `要submodule照合`。§3.6（Dart は `body > form > table > tbody > tr` の連番
  `day=i~/7, period=i%7+1` に依存、universal_html の tbody 自動補完前提）、§3.7（PC ログインフローと
  25 回ループ）、§9.4（単一セッション相互無効化）はいずれも Dart/実観測メモ。TS 側は tbody 依存を
  避け曜日 th/時限 th 走査に **意図的に変更**しているため、Dart 準拠ではなく実 HTML 準拠。要照合。
- **リスク**:
  1. **TOKEN 生存判定の前提崩れ**: 時間割ページに Struts TOKEN が **元から無い**設計だと、
     セッションが生きていても常に `LcamExpiredError` → 恒常的に壊れる（CODE_REVIEW #10「実データ未観測」）。
     時間割は token 不要 GET のため、TOKEN の有無は連絡系ページと異なる可能性がある＝ここが最大の未確認点。
  2. **連鎖A**: schedule タブと他タブを往復するたびに相互無効化 → 再ログイン → KV write 増幅。
     無料枠圧迫＋（N2 未回復導線と重なると）恒久 500 化。設計は自動復帰を意図するが、
     復帰が「毎回発火」する点は実データでの頻度確認が要る。
  3. 曜日 th 走査への変更（`thurstay` タイポ含む、parse.ts L534）で **木曜が欠落**しうる
     （CODE_REVIEW P6/N4）。これは静的に確認できる別個の疑い（下記「補足」参照）。
- **検証方法**: 認証済みで (a) `nextPage/timeTable` の実 HTML を採取し **TOKEN フィールドの有無**を確認
  （無ければ `assertSpSessionAlive` を時間割には使わない設計へ要変更）、(b) schedule 取得直後に
  timetable/notices を叩き、SP セッションが実際に無効化され再ログインが走るか頻度を観測、
  (c) 実時間割で曜日 th の実文字（`木` 等）とセル構造を確認。
- **判定**: `要検証`（実バグ確度[中]・TOKEN 前提について特に）。時間割ページの TOKEN 有無が未観測のまま
  生存判定の単一根拠になっている点は構造的に危うい。相互無効化は §9.4 で観測済み前提だが、
  再ログイン頻度と連鎖の実害度は実測が要る。

### 200 で Shift_JIS を返すページの有無（文字化け）

- **現状**:
  worker 内の上流ボディ取得は **すべて `res.text()`**（UTF-8 固定デコード）。明示的な charset 判定・
  `TextDecoder('shift_jis')`・`arrayBuffer()→再デコード` は **一切ない**
  （`worker/src/upstream/{lcam,syllabus,moodle}` 全 `res.text()`、grep で確認）。
  唯一の TextDecoder 使用は `crypto/aes.ts`・`session/cookie.ts` の内部データ（UTF-8）向けで上流無関係。
  シラバスは MIGRATION_NOTES §9.1/§204 で「UA 無しだと `/ext_syllabus/` が **HTTP 500**（Shift_JIS の
  L-Cam エラーページ）、UA を付けると 200」。access.ts は UA を必ず付け、かつ **200 以外を例外**にする。
- **移植元Dartの事実**: `要submodule照合`。§9.1 は UA 有無で 500/200 が分かれる旨の実観測メモ。
  Dart の `access_syllabus.dart` が明示 charset デコードをしているか否かは Dart 実物で要確認。
- **リスク**:
  1. もし **正常系 200 のページのいずれかが Shift_JIS/EUC-JP** を返すと、`res.text()`(UTF-8) が
     日本語を文字化けさせ、(a) 表示崩れ、(b) パースのラベル一致（`評価 :`・`前期`・`重要`・`参考URL` 等）が
     全滅、(c) `looksLikeLoginPage`/`assertSpSessionAlive` の marker（ASCII）は生存するので失効誤検知は
     しにくい、という影響。CODE_REVIEW は「現経路では無害と確定（正常系 UTF-8、Shift_JIS エラーページは
     status≠200 でパース前 throw、detect マーカーは ASCII で生存）」と結論づけている（§166/§195/§227）。
  2. ただしこの「正常系 UTF-8」判断自体が **LCAM 系は未認証検証のみ**（§251）で、実 `Content-Type` /
     `<meta charset>` を全ページで確認したわけではない。将来 Shift_JIS を明示デコードする実装を足すと
     workerd で `TextDecoder('shift_jis')` が使えず落ちる、という別の罠も指摘済み（§227）。
- **検証方法**: 認証済みで各 LCAM SP ページ・シラバス詳細・Moodle の実レスポンス `Content-Type` ヘッダと
  HTML `<meta charset>` を採取し、**200 応答の実文字コードを一覧化**。Shift_JIS を返す 200 ページが
  1 つでもあれば、そのエンドポイントだけ `arrayBuffer()`＋明示デコード（workerd 対応方法の要調査）へ。
- **判定**: `問題なし`寄りの `要検証`（実バグ確度[低]）。静的読解＋CODE_REVIEW の複数エージェント結論では
  「正常系は UTF-8、Shift_JIS は非 200 でパース前に弾かれる」で無害。ただし LCAM 系正常応答の実 charset を
  全網羅で観測したわけではないため、`低`確度の未確認として残す。

---

## 補足: 本台帳と CODE_REVIEW の対応

| 本台帳 | CODE_REVIEW での該当 |
|---|---|
| A1 成績評点 | 第3弾「A1成績評点(誤表示)」、第4弾 成績 subject ヒューリスティック誤爆 |
| A4 アンケート失敗 | #（第2弾）S5/S8、第3弾「A4アンケート失敗レスポンス未観測(誤送信)」 |
| A2/§3.5 detect | 中程度 #6、第3弾「A2 detect実ログインページ未観測」 |
| 時間割 TOKEN / schedule 連鎖 | 中程度 #10、C7、連鎖A、P6/N4（曜日欠落） |
| Shift_JIS 200 | 中程度 #9、第2弾視点9、第3弾/第4弾 文字コード（現経路無害と結論） |
| B2 submodule | 第5弾 B1/B2 |

## 補足: 本台帳で「静的に確定」できた別個の疑い（実観測不要）

以下は実 HTML 無しでもソース上で確認できるため参考記録（**本ブランチでは修正しない**、別途対応）:

- `parse.ts` L534 曜日マップの `木: 'thurstay'` は **綴り誤り**（`thursday` が正）。TS 内部キーとして一貫して
  使う限り木曜が「欠落」はしないが、この文字列を外部（web/mcp/カレンダー ICS 等）で曜日判定に使う箇所が
  あれば木曜だけ不一致になりうる。→ 消費側の照合が必要（静的追跡課題）。
- `looksLikeSuccess`（client.ts）と `isLoginSuccess`（detect.ts）は同型の **fail-open** で、A4 と A2 の
  リスクを共有する（成功の肯定マーカー不使用）。
