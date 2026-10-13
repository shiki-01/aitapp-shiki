# aitapp-web

愛知工業大学ポータル（LiveCampus / Moodle / シラバス）の非公式 Flutter アプリ
（[ROTO0504/aitapp](https://github.com/ROTO0504/aitapp)）を Web へ移植したもの。
ブラウザから大学サーバーへ直接アクセスすると CORS でブロックされるため、Cloudflare
Workers をサーバーサイド proxy（BFF）として挟み、ログインを永続化する。

要件は [`REQUIREMENTS.md`](REQUIREMENTS.md)、移植元の把握内容と要確認事項は
[`MIGRATION_NOTES.md`](MIGRATION_NOTES.md) を参照。

## 構成

```
worker/   Cloudflare Workers + Hono + TypeScript（BFF / 上流 proxy。/mcp でリモートMCPも提供）
web/      SvelteKit（Svelte 5）SPA（本番は worker が同一オリジンで静的配信 / Tauriのフロントとしても共用）
tauri/    PC版デスクトップアプリ（Tauri + Rust。web/のビルド成果物を表示する）
mcp/      MCPサーバー（stdioローカル実行。ツール実装は worker/ の /mcp と共用）
vendor/aitapp  移植元 Dart 実装（git submodule）
```

- proxy が認証情報を AES-GCM で暗号化し Workers KV に保存する。
- Moodle は token 方式で、失効したら保存済み認証情報で再取得して 1 回だけリトライする。
- LCAM は Entra ID の多要素認証（SSO）のため、Worker は最初のログインを自動化できない。初回に 1 回だけ、
  本家アプリと同じ方式で `lamyapp://` の key を登録すると、以後は Worker が保存済みの資格情報で
  自動的に再ログインする（下記「LCAM 連携」）。
- ブラウザへ渡るのは HttpOnly な署名付き session cookie のみ。認証情報は渡さない。

詳細なアーキテクチャは `REQUIREMENTS.md` 第5節を参照。

## 必要環境

- [Bun](https://bun.sh/)
- Cloudflare アカウント（無料枠）と [Wrangler](https://developers.cloudflare.com/workers/wrangler/)

submodule を含めて clone する:

```sh
git clone --recurse-submodules <this-repo>
# 既に clone 済みなら
git submodule update --init --recursive
```

## セットアップ（worker）

```sh
cd worker
bun install
```

### 1. KV namespace を作成

```sh
bunx wrangler kv namespace create USER_KV
bunx wrangler kv namespace create USER_KV --preview
```

出力された `id` / `preview_id` を `worker/wrangler.toml` の `kv_namespaces` に記入する。

### 2. シークレットを登録

`CRED_KEY`（credential 暗号化）と `SESSION_SECRET`（session 署名）は**別の鍵**にする。

```sh
# 任意の十分に長いランダム文字列を投入する（例: openssl rand -base64 48）
bunx wrangler secret put CRED_KEY
bunx wrangler secret put SESSION_SECRET
# 不可逆/取り消しにくい書き込み操作（クイズ受験開始・確定、課題の下書き保存・
# ファイル添付・最終提出、アンケート提出）を許可するための out-of-band 確認秘密。
# MCP ホストの AITAPP_CONFIRM_SECRET と同一値にする。未設定だと該当書き込みは常に拒否される。
bunx wrangler secret put CONFIRM_SECRET
```

ローカル開発では `worker/.dev.vars` に置く（gitignore 済み）:

```
CRED_KEY=ローカル用のランダム文字列
SESSION_SECRET=別のローカル用ランダム文字列
CONFIRM_SECRET=書き込み許可用のランダム文字列（MCPホストのAITAPP_CONFIRM_SECRETと同一値）
```

#### シークレットのローテーション

漏洩時やローテーションポリシー上で鍵を差し替える場合の手順と影響。2 つの鍵は
用途が独立しており、影響範囲も別々になる（[実装] `src/crypto/aes.ts` /
`src/session/cookie.ts`）。

- **`CRED_KEY`（credential 暗号化鍵, AES-GCM）を差し替えると、KV に保存済みの全
  credential が復号不能になる。** 鍵はバージョン管理しておらず（過剰実装を避けるため
  dual-key/鍵バージョン方式は採らない）、旧鍵で暗号化された暗号文は新鍵では復号できない。
  結果として**全ユーザーが再ログインするまで透過再ログインが失敗する**（ログイン時に
  新鍵で暗号化し直されて回復する）。数人〜10 人規模の運用前提のため、この一斉再ログインは
  許容コストとして受け入れる。
- **`SESSION_SECRET`（session cookie 署名鍵, HMAC-SHA256）を差し替えると、発行済みの
  全 session cookie の署名検証が失敗する。** つまり**全ユーザーがログアウト状態になり
  再ログインが必要**になる。credential 自体（KV）は無傷なので、再ログインすれば
  そのまま使える。

```sh
cd worker
# どちらか一方、または両方を差し替える（値は新しいランダム文字列にする）
bunx wrangler secret put CRED_KEY        # → 全 credential が復号不能。全員の再ログインが必要
bunx wrangler secret put SESSION_SECRET  # → 全 session 失効。全員の再ログインが必要
```

> KV の各ユーザー state には TTL（90 日 sliding、`src/store/kv.ts`）が付いており、
> 書き込みのたびに延命される。鍵ローテーション後に再ログインしなかった孤児 state は
> この TTL で自動失効する。

### 3. `APP_ORIGIN`

`wrangler.toml` の `[vars] APP_ORIGIN` をフロントのオリジンに合わせる。
本番はフロントを Worker 自身が静的配信する（下記「セットアップ（web）」参照）ため
API と同一の `https://aitapp.shiki-01.com`（wrangler.toml に記載済み）。
ローカル開発時（vite dev 分離構成）は `worker/.dev.vars` に
`APP_ORIGIN=http://localhost:5173` を書いて上書きする（`.dev.vars` は `[vars]` より優先される）。

> **SameSite=Strict の制約**: session cookie は `SameSite=Strict` のため、フロントと
> Worker は**同一 registrable domain（eTLD+1）**に揃える必要がある。本番は同一オリジン
> 配信なので自動的に満たされる。ローカルは双方 `localhost`（別ポートは same-site）で成立する。

### 4. ローカル起動 / デプロイ

```sh
bunx wrangler dev      # http://localhost:8787
bunx wrangler deploy   # 本番へ
```

> **【重要な制約】LCAM は Cloudflare の egress IP を拒否する**: デプロイした worker からの
> `lcam.aitech.ac.jp` へのアクセスは WAF（Zenedge）に拒否され、常に 500 になる
> （Moodle・シラバスは正常）。本番では LCAM 宛のみ非 Cloudflare の relay を経由する
> （`LCAM_RELAY_URL`。`MIGRATION_NOTES.md` §13.1 / §13.4）。ローカル実行（`wrangler dev`）は直続。

## LCAM 連携（多要素認証への対応）

LCAM は 2026-09 から Entra ID の SSO + 多要素認証になり、ID/パスワードの直接ログインは
拒否される。`/api/auth/login` は **Moodle の認証のみ**で通る。LCAM は **本家 L-Cam アプリと同じ方式**
（`MIGRATION_NOTES.md` §15）で、初回の 1 回だけ登録する。

1. SP 経路の SSO（`https://lcam.aitech.ac.jp/portalv2/sp`、MFA 込み）を通すと、終端が `lamyapp://lcam?key=…`
   になる。この URL（key）を Worker に登録する。key は使い捨てで短時間で無効になる。
   - デスクトップ版（Tauri）: 「その他 → LCAM 連携 → LCAM に接続」。WebView が `lamyapp://` を傍受して
     自動で登録する（実機での傍受は未検証）。
   - Web 版: DevTools（F12）→ Network →「Preserve log」を ON にして `/portalv2/sp` にログインし、
     `lamyapp://…` の URL（302 の `Location`、または Console のエラー文言）をコピーして
     「その他 → LCAM 連携」に貼り付ける。または MCP ツール `lcam_set_session` の `appKey` に渡す。
2. Worker が key を `spAppLogin/` で資格情報（userId + アプリ用トークン）に交換し、AES-GCM（`CRED_KEY`）で
   暗号化して KV に保存する。以後は `smartPhoneLogin/`（`spAppFlag=1`・`lCamApp=Y`）で MFA なしにセッションを作れる。

- 失効を検知したら（別の場所で LCAM にログインした場合、1 時間 30 分の無操作など）、保存した資格情報で
  自動的に再ログインし、同じ操作を **1 回だけ**再試行する。定期的な ping（keep-alive）はしない。
- LCAM は**ユーザーあたり単一セッション**。PC 版ブラウザや公式アプリで LCAM にログインすると Worker のセッションが
  切れ、Worker が再ログインすると他の場所のログインが切れる（実測済み。`MIGRATION_NOTES.md` §15.5）。
- 資格情報が拒否された（アプリ用トークンの失効など）場合は破棄し、HTTP 424（`reauth_required`・`target: lcam`）で
  再登録を求める。「その他 → LCAM 連携 → 登録を解除」（`POST /api/lcam/session/revoke`）で資格情報ごと削除できる。
- 従来の Cookie 貼り付け登録（`POST /api/lcam/session` の `cookies`）も残してあるが、こちらは失効したら再登録が必要。
- `GET /api/lcam/session` で登録時刻・最終成功時刻・失効検知時刻を確認できる（Cookie の値は返さない）。
- 最小 Cookie の実測: `cd worker && LCAM_COOKIES='JSESSIONID=…; LiveApps-Cookie=…' bun run scripts/lcam-cookie-probe.ts`
  （SP 時間割への GET のみ・最大 4 リクエスト）。**PC 画面へ GET で直接アクセスしないこと**（セッションが破棄される）。

### 上流エラー（相関ID）の調査手順

- 画面に表示された `エラーコード` は worker の `correlationId`。
- worker の構造化ログ（`console.error`）で同じ `correlationId` を検索すると、
  `path` / `upstreamService` / `errorName` / `detail` を確認できる。
- `upstreamService` は `lcam` / `moodle` / `syllabus` / `unknown` のいずれか。

記録のみ（未修正）として扱う事象:

- Issue #36
  - 発生日時: 2026-07-21
  - エラーコード: `baf80932-8ec5-4164-90fa-04f74e9f58cb`
  - 状態: 原因調査待ち（上流サービス特定とログ突合せが必要）

## セットアップ（/mcp リモートMCP）

worker には MCP Streamable HTTP エンドポイント `/mcp` があり、デプロイすると
Claude Code 等からクラウド経由でツールを使える（ローカルの `mcp/` を起動しなくてよい）。
トークンは 2 種類あり、併用できる。

| | ユーザー別トークン（推奨・複数人向け） | owner トークン（従来・単一ユーザー） |
|---|---|---|
| 発行方法 | Web アプリでログイン → 「その他」→「Claude 連携 (MCP)」→ 発行 | `wrangler secret put MCP_TOKEN` |
| 資格情報 | 本人が Web ログイン時に KV へ暗号化保存したもの | worker のシークレット（`AITAPP_ID` 等） |
| 失効 | 画面から失効/再発行、または logout（state 削除） | シークレット差し替え |
| 書き込み系ツール | 使えない（常に confirm 拒否。閲覧系のみ） | `CONFIRM_SECRET` 設定時に可 |

### ユーザー別トークン（自己発行・マルチユーザー）

各ユーザーは自分の愛工大 ID（Moodle 認証）で Web アプリにログインし、自分専用の
`/mcp/<token>` URL を自己発行する（`POST /api/auth/mcp-token`）。worker 管理者が
ユーザーごとに設定する項目はない。

- トークンは `u.<base64url(userId)>.<乱数64hex>` 形式。KV には SHA-256 ハッシュのみ
  保存し、平文は発行時の応答でしか表示されない（紛失時は再発行）。
- 再発行すると旧トークンは無効になる。logout すると KV state ごと消えるため
  トークンも無効になる（再ログイン後に再発行が必要）。
- ツール実行は本人の KV state（暗号化 credential・上流 cookie・Moodle token）で行われ、
  worker 管理者の資格情報には触れない。
- 書き込み系ツール（クイズ・課題・アンケートの提出等）は out-of-band 確認秘密を
  ユーザー別に受け渡す経路が無いため、fail-closed で常に拒否する（閲覧系のみ）。

### owner トークン（従来方式・worker 管理者用）

資格情報を worker のシークレットに置く単一ユーザー方式。

```sh
cd worker
bunx wrangler secret put MCP_TOKEN              # /mcp の認証トークン（例: openssl rand -hex 32。URLに埋め込むためパスセーフな文字のみで生成する）
bunx wrangler secret put AITAPP_ID              # 大学ポータルのログインID
bunx wrangler secret put AITAPP_PASSWORD        # 大学ポータルのパスワード
bunx wrangler secret put AITAPP_MOODLE_ORIGIN   # 例: cms.aitech.ac.jp
# LCAMとMoodleのアカウントが別の場合のみ:
#   bunx wrangler secret put AITAPP_MOODLE_ID
#   bunx wrangler secret put AITAPP_MOODLE_PASSWORD
```

`/mcp` 経由で書き込み系ツール（クイズ・課題・アンケートの提出等）を使う場合は、
上の「シークレットを登録」で設定した `CONFIRM_SECRET` が必須（未設定だと該当書き込みは
常に拒否される）。`/mcp` 実行ではツール側の確認値も worker の `CONFIRM_SECRET` から
供給されるため、別途 `AITAPP_CONFIRM_SECRET` を渡す必要はない（stdio 実行のときだけ
MCP ホストの env に `AITAPP_CONFIRM_SECRET` を `CONFIRM_SECRET` と同一値で設定する）。

ユーザー別 MCP トークン（Web 画面から自己発行した `/mcp/<token>` URL）では、worker の
`CONFIRM_SECRET` 設定に加えて、本人が Web 画面（その他 → Claude 連携）の
「不可逆操作を許可」をオンにした場合のみ提出系操作が実行できる（既定はオフ＝拒否）。

owner 用シークレット（`MCP_TOKEN` 等）が未設定でも、ユーザー別トークンによる
`/mcp` は常に有効（不正トークンには 401 を返す）。

Claude Code への登録:

```sh
claude mcp add --transport http aitapp-cloud \
  https://<worker-origin>/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

### スマホ（Claude アプリ）から使う

スマホの Claude アプリはコネクタ（リモートMCP）に対応しているが、カスタムコネクタでは
`Authorization` 等のカスタムヘッダを設定できない。そのためトークンを URL パスに
埋め込んだエンドポイント `/mcp/<token>` を用意している（認証の中身はヘッダ方式と同一。
ユーザー別トークン・owner トークンのどちらも使える）。

1. claude.ai（Web）の **設定 → コネクタ → カスタムコネクタを追加** で、URL に
   `https://<worker-origin>/mcp/<token>`（Web アプリで発行した MCP URL そのまま、
   または owner の `/mcp/<MCP_TOKEN>`）を登録する（コネクタはアカウント単位
   なので、Web で追加すればスマホアプリからも使える）。
2. スマホの Claude アプリでチャットのコネクタ一覧から有効化して使う。

注意:

- トークンが URL に含まれるため、URL の扱いは Bearer トークンと同等に秘匿する
  （チャットや共有リンクに貼らない）。漏れた場合、ユーザー別トークンは Web アプリの
  「Claude 連携 (MCP)」から再発行/失効、owner トークンは `wrangler secret put MCP_TOKEN`
  で新しい値に差し替えれば無効化できる。
- `MCP_TOKEN` は URL パスに使える文字だけで生成する（推奨: `openssl rand -hex 32`。
  `base64` は `/` や `+` を含みうるため不可）。
- ユーザー別トークンの発行・再発行の反映は Workers KV の伝播遅延で最大 1 分ほど
  かかることがある。反映前にコネクタ登録すると認証に失敗し、Claude 側では
  「aitapp のサインインサービスに登録できませんでした。…OAuth Client ID を追加して
  ください」という OAuth 由来のエラー（`ofid_...` 参照番号付き）として表示される。
  この場合は 1 分ほど待ってから再登録すればよい（OAuth の設定は不要。本サーバーの
  認証は URL 埋め込みトークンのみで、OAuth には対応していない）。
- スマホからの利用は必然的にデプロイ版 worker 経由になるため、下記の制約どおり
  **LCAM 系ツール（`lcam_*`）は使えない**（Moodle 系・シラバス系は使える）。

制約:

- 上記のとおり **LCAM 系ツール（`lcam_*`）はデプロイ版では上流に拒否され使えない**
  （Moodle 系・シラバス系は動作確認済み）。
- ファイルダウンロード系ツールはローカル実行と異なりパスではなく内容そのもの
  （base64、上限10MB）を返す。`moodle_upload_assignment_file` は `filePath` の代わりに
  `fileBase64` + `fileName` を使う。

## セットアップ（web）

```sh
cd web
bun install
cp .env.example .env    # VITE_API_BASE を Worker の URL に設定
bun run dev             # http://localhost:5173
```

ビルド / デプロイ（本番はフロントを **Worker が同一オリジンで静的配信**する。
`worker/wrangler.toml` の `[assets] directory = "../web/build"`）:

```sh
# 1. web をビルド（API ベース URL は Worker 自身のオリジン）
cd web
VITE_API_BASE=https://aitapp.shiki-01.com bun run build
# 2. worker をデプロイすると build/ が一緒にアップロードされる
cd ../worker
bunx wrangler deploy
```

本番構成（デプロイ済み）:

- **`https://aitapp.shiki-01.com`** で API・フロント・`/mcp` すべてを配信する
  （単一オリジン。SameSite=Strict / CORS の制約を構成で満たす。Pages は使わない）。
- フロント配信部分には Basic 認証がかかる（`[vars] WEB_BASIC_AUTH = "user:pass"`）。
  公開 URL の覗き見防止が目的で、`/api`（session cookie）と `/mcp`（MCP_TOKEN）は
  対象外のため Tauri / MCP クライアントには影響しない。

## セットアップ（PC版デスクトップアプリ / tauri）

PC版はWorkerへ`永続ログイン`する。ブラウザ版とは異なり、Rust backend（`tauri/src-tauri`）
がWorkerへ直接HTTPで通信し、session cookieが失効した際は保存済みcredentialで
ユーザーに再入力させず自動的に再ログインする。愛工大ID/パスワードはOSキーチェーン
（Windows Credential Manager / macOS Keychain / Linux Secret Service）に暗号化保存され、
webview(JS)側には一切渡らない。

### 必要環境

- [Rust](https://www.rust-lang.org/) / [Tauri CLI](https://tauri.app/)（`cargo install tauri-cli --version "^2"` などで導入）
- Linux開発時: `libgtk-3-dev` `libwebkit2gtk-4.1-dev` `libayatana-appindicator3-dev` `librsvg2-dev`
- Linuxでの永続ログインには Secret Service（gnome-keyring / kwalletd 等）が起動している環境が必要。
  無い環境ではcredential保存に失敗する（Windows/macOSを優先対応とし、この制約はスコープ外の代替実装を作らない）。

### ビルド

```sh
cd tauri/src-tauri
# 本番Workerへ向ける場合は環境変数でビルド時に埋め込む（未設定時は localhost 開発値）
AITAPP_WORKER_BASE_URL=https://<worker-origin> \
AITAPP_APP_ORIGIN=https://<pages-origin> \
cargo tauri build
```

`tauri.conf.json` の `beforeBuildCommand` が `web/` を `bun run build:desktop`
（`VITE_PLATFORM=desktop`）でビルドし、その成果物 (`web/build`) をそのままフロントとして
バンドルする。

開発時は `cargo tauri dev`。`beforeDevCommand`（`web/` で `bun run dev:desktop`、内部は
`vite dev --mode desktop`）が起動する Vite dev server (`http://localhost:5173`、
`devUrl` で指定) にwebviewが接続するため、`web/` の変更はHMRでTauriウィンドウに
即時反映される（ビルドし直す必要はない。`web/` で手動で `bun run dev` 等を別途
実行する必要はなく、むしろポート競合で失敗するので実行しない）。
`tauri.conf.json` を変更した場合は `cargo tauri dev` 自体の再起動が必要。

#### macOS: 開発中のKeychain許可プロンプトを抑える

macOSのデバッグビルドはRustコードを変更してビルドし直す度にad-hoc署名
(バイナリのハッシュ値が識別子になるため毎回変わる)がリンカにより自動付与され、
Keychainが「常に許可」を保持できず`restore_session`のキーチェーン読み取りの度に
許可プロンプトが出る。安定した自己署名の証明書で署名し直すことで回避できる。

1. `Keychain Access.app` → メニュー「証明書アシスタント → 証明書を作成...」
   - 名前: `aitapp-desktop-dev`
   - 識別情報の種類: 自己署名ルート / 証明書の種類: コード署名
2. 作成した証明書をダブルクリック → 信頼 → コード署名を「常に信頼」に変更
3. `cargo tauri dev` と並行して別ターミナルで以下を起動しておくと、Rustの
   再ビルドを検知して自動的に再署名される:
   ```sh
   tauri/scripts/watch-codesign.sh
   ```
   証明書名を変えた場合は `AITAPP_CODESIGN_IDENTITY=<証明書名>` を付けて実行する。

### LCAM への接続（多要素認証）

LCAM は多要素認証のため、アプリの「その他 → LCAM 連携」に **「LCAM に接続」** ボタンがある。押すとログイン用の
ウィンドウ（SP 経路）が開き、Microsoft のログイン（必要なら番号入力）を通すと、終端の `lamyapp://lcam?key=…` への遷移を
WebView が傍受し、その key を Worker に登録する（Worker が資格情報に交換して保存する。Microsoft の Cookie は
WebView の外に出さない。key・URL はログに出さない）。以後は、失効しても Worker が自動で再ログインする。
LCAM は単一セッションのため、再ログインするとブラウザ等の LCAM は切れる。
**「切れたとき自動で再接続する」**（既定オフ）は、資格情報が未登録または拒否されたときだけ動く。
Tauri の接続先の既定はローカルの Worker（`localhost:8787`）。本番向けには、ビルド時に
`AITAPP_WORKER_BASE_URL` / `AITAPP_APP_ORIGIN` を指定する。詳細は `MIGRATION_NOTES.md` §15。

### iOS 版（署名なし IPA）

GitHub の Actions →「iOS IPA (unsigned)」→「Run workflow」で、署名なしの `.ipa` を作れる（artifact を 7 日間ダウンロード可）。
AltStore / SideStore / Sideloadly で自分の Apple ID により再署名して端末に入れる（無料アカウントは 7 日で失効。有料プログラム不要）。
ビルドまでは CI で確認済みだが、端末での動作は未確認。詳細と確認項目は `MIGRATION_NOTES.md` §14.10。

### PC版のフロント差分

`web/src/lib/platform.ts` の `isDesktop`（ビルド時フラグ）で、ブラウザ版と以下を切り替える。

- ナビゲーション: モバイル用 `BottomNav` → PC用 `SideNav`
- API経路: browser版は `fetch`（cookie送信）、desktop版は Tauri `invoke` 経由で Rust backend が中継
  （TauriのwebviewはWorkerと別サイト扱いになり `SameSite=Strict` cookieが送れないため）
- 添付ファイル: browser版は `<a target=_blank>`、desktop版は一時ファイルに保存しOS既定アプリで開く

## セットアップ（mcp / stdioローカル実行）

Claude Code等のMCPクライアントから `worker/` のAPIをツールとして使うための
stdio サーバー。クラウド経由で使う場合は上記の「/mcp リモートMCP」を使う
（ツール実装は共通）。詳細は [`mcp/README.md`](mcp/README.md) を参照。

```sh
cd mcp
bun install
```

`worker/` を先に起動（`bunx wrangler dev` またはデプロイ済みURL）した上で、
Claude Codeの `.mcp.json` に登録して使う。認証情報・上流ロジックは全て
`worker/` 側に委譲し、`mcp/` はセッションcookieを保持するだけの薄いクライアント。

## 公開 API（BFF）

| メソッド | パス | 内容 |
|----------|------|------|
| POST | `/api/auth/login` | id/password → Moodle 認証で検証 → credential 暗号化保存 → session cookie 発行（LCAM は対象外） |
| GET | `/api/lcam/session` | LCAM の登録状況（`registered` / `appRegistered`、登録/最終成功/失効の時刻） |
| POST | `/api/lcam/session` | LCAM を登録（`{ appKey }` = `lamyapp://` の URL または key。推奨。または `{ cookies }`。有効性を確認してから保存） |
| POST | `/api/lcam/session/revoke` | LCAM の登録（Cookie・資格情報）を解除 |
| POST | `/api/auth/logout` | session cookie 破棄 |
| GET | `/api/auth/me` | ログイン中の userId |
| GET | `/api/notices?type=common\|class&count=10` | LCAM 連絡（登録済みの資格情報。失効しても自動で再ログイン。回復できないときは 424） |
| GET | `/api/notices/detail?type=&index=` | 連絡詳細 |
| GET | `/api/timetable` | LCAM 時間割（SP） |
| GET | `/api/schedule?weeks=&month=` | 個人スケジュール（休講・補講・学校行事）。SP の token で PC ホームをメニュー遷移（POST）で開いて`weeks` 週（既定 6・最大 14）を取得。`month=N`（-8〜8）で今月から N か月ずらした月の 1 日を含む週から（広い範囲は分けて呼ぶ）。実 LCAM で動作確認済み（MIGRATION_NOTES §16）。PC 画面への直接 GET はセッションを破棄するため使わない |
| GET | `/api/assignments` | Moodle 課題（token 経由） |
| GET | `/api/syllabus/filters?year=` | シラバス検索フィルタ |
| GET | `/api/syllabus/search?year=&word=&campus=&semester=&week=&hour=&folder=` | シラバス検索 |
| GET | `/api/syllabus/detail?url=` | シラバス詳細 |
| GET | `/api/file/:id` | 添付バイナリ（stream proxy、`:id` は相対 URL の base64url） |
| GET | `/api/commonfiles` `/detail?id=` `/download?id=&no=` | 学内共有ファイル（PC 版。MIGRATION_NOTES §17） |
| GET | `/api/reports[?year=&semester=1\|2&unsubmitted=1]` `/detail?id=` `/download?id=&submitNo=&fileNo=` | レポート（一覧・参照・提出履歴のファイル。提出は未対応） |
| GET | `/api/facilities` `/schedule?ids=a,b&week=` | 施設の一覧と週の使用状況（空き教室） |
| GET | `/api/pcnotices?kind=campus\|class&keyword=…` `/detail` `/file` | 学内連絡・授業連絡の検索（キーワード・カテゴリ・日付・未読・ToDo・添付・科目） |
| GET | `/api/credits` `/api/curriculum` `/api/schoolevents[?month=]` `/api/lottery` | 学事システム: 単位修得情報・カリキュラム・年間行事・抽選履修登録結果 |
| GET | `/api/staff?name=` `/api/staff/schedule?name=&code=&week=` | 教職員スケジュール |
| GET | `/api/open/kyoumu?to=register\|cancel\|lottery` | 学事システム（本家）を開く（引き渡しのあと、履修登録・履修取消・抽選履修登録の画面へ移動）。ブラウザで行うためのリンク先 |

## 開発コマンド

```sh
# worker
cd worker && bunx tsc --noEmit                            # 型チェック
cd worker && bunx wrangler deploy --dry-run --outdir dist # バンドル検証

# web
cd web && bunx svelte-check --tsconfig ./tsconfig.json    # 型チェック
cd web && bun run build                                   # 本番ビルド
```

## 制約・スコープ外

- Cloudflare 有料機能（Durable Objects 等）は不使用。状態は Workers KV。
- 並行再ログインの直列化・即時失効・keep-alive・自動復旧は実装しない（要件 §11）。LCAM は、保存済みの資格情報
  （アプリ方式。`MIGRATION_NOTES.md` §15）による透過再ログイン（失効検知 → 再ログイン → 1 回だけ再試行）のみ行う。
- MFA/番号入力の自動化・回避策は作らない。資格情報が無い・拒否された場合は、失効を検知してエラー（424）を返すのみ
  （回復はユーザーによる再登録）。
- 未確認・未対応・要修正の項目は `docs/BACKLOG.md` に一覧がある。

## 注意

移植元・本実装とも大学ポータルの非公式スクレイピングであり、上流の利用規約・負荷に
配慮して個人〜知人範囲（数人〜最大10人程度）で利用する前提。

## iOS / TestFlight（署名付きビルド）

`.github/workflows/ios-testflight.yml`（手動実行）が署名付き IPA をビルドして TestFlight にアップロードする。
Bundle ID は `com.shiki01.aitapp`。GitHub の Secrets に以下を登録する。

| Secret | 内容 |
|---|---|
| `APPLE_TEAM_ID` | Apple Developer の Team ID（10 文字） |
| `APPSTORE_ISSUER_ID` / `APPSTORE_KEY_ID` | App Store Connect API キーの Issuer ID / Key ID |
| `APPSTORE_API_KEY_P8` | API キー（.p8）の中身（全文） |
| `IOS_CERTIFICATE_P12_BASE64` | Apple Distribution 証明書（.p12）の base64（`base64 -i cert.p12 \| pbcopy`） |
| `IOS_CERTIFICATE_PASSWORD` | .p12 を書き出す際のパスワード |
| `IOS_PROVISION_PROFILE_BASE64` | App Store 用プロビジョニングプロファイル（.mobileprovision）の base64 |
