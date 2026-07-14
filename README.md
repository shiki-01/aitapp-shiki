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
web/      SvelteKit（Svelte 5）SPA（Cloudflare Pages 配信 / Tauriのフロントとしても共用）
tauri/    PC版デスクトップアプリ（Tauri + Rust。web/のビルド成果物を表示する）
mcp/      MCPサーバー（stdioローカル実行。ツール実装は worker/ の /mcp と共用）
vendor/aitapp  移植元 Dart 実装（git submodule）
```

- proxy が認証情報を AES-GCM で暗号化し Workers KV に保存する。
- 上流セッション失効を検知したら保存済み認証情報で透過再ログインし、同一リクエストを
  1 回だけリトライする。
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
```

ローカル開発では `worker/.dev.vars` に置く（gitignore 済み）:

```
CRED_KEY=ローカル用のランダム文字列
SESSION_SECRET=別のローカル用ランダム文字列
```

### 3. `APP_ORIGIN`

`wrangler.toml` の `[vars] APP_ORIGIN` をフロントのオリジンに合わせる。
ローカルは `http://localhost:5173`、本番は Pages のオリジン。

> **SameSite=Strict の制約**: session cookie は `SameSite=Strict` のため、フロントと
> Worker は**同一 registrable domain（eTLD+1）**に揃える必要がある
> （例: `app.example.com` と `api.example.com`）。ローカルは双方 `localhost` で成立する。

### 4. ローカル起動 / デプロイ

```sh
bunx wrangler dev      # http://localhost:8787
bunx wrangler deploy   # 本番へ
```

> **【重要な制約】LCAM は Cloudflare の egress IP を拒否する**: デプロイした worker からの
> `lcam.aitech.ac.jp` へのアクセスは WAF（Zenedge）に拒否され、常に 500 になる
> （Moodle・シラバスは正常）。そのため**デプロイ版では LCAM 系機能と
> `/api/auth/login`（LCAM 検証を含む）が動かない**。LCAM を含む全機能を使う場合は
> ローカル実行（`wrangler dev`）を使う。詳細は `MIGRATION_NOTES.md` §13.1。

## セットアップ（/mcp リモートMCP）

worker には MCP Streamable HTTP エンドポイント `/mcp` があり、デプロイすると
Claude Code 等からクラウド経由でツールを使える（ローカルの `mcp/` を起動しなくてよい）。
単一ユーザー前提で、資格情報は worker のシークレットに置く。

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

未設定の間 `/mcp` は 404 を返すだけで、既存 API に影響しない。

Claude Code への登録:

```sh
claude mcp add --transport http aitapp-cloud \
  https://<worker-origin>/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

### スマホ（Claude アプリ）から使う

スマホの Claude アプリはコネクタ（リモートMCP）に対応しているが、カスタムコネクタでは
`Authorization` 等のカスタムヘッダを設定できない。そのためトークンを URL パスに
埋め込んだエンドポイント `/mcp/<MCP_TOKEN>` を用意している（認証の中身はヘッダ方式と同一）。

1. claude.ai（Web）の **設定 → コネクタ → カスタムコネクタを追加** で、URL に
   `https://<worker-origin>/mcp/<MCP_TOKEN>` を登録する（コネクタはアカウント単位
   なので、Web で追加すればスマホアプリからも使える）。
2. スマホの Claude アプリでチャットのコネクタ一覧から有効化して使う。

注意:

- トークンが URL に含まれるため、URL の扱いは Bearer トークンと同等に秘匿する
  （チャットや共有リンクに貼らない）。漏れた場合は `wrangler secret put MCP_TOKEN`
  で新しい値に差し替えれば即座に無効化できる。
- `MCP_TOKEN` は URL パスに使える文字だけで生成する（推奨: `openssl rand -hex 32`。
  `base64` は `/` や `+` を含みうるため不可）。
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

ビルド / デプロイ（Cloudflare Pages, 出力は `web/build`）:

```sh
bun run build
# Pages へ: ビルド出力 build/ を Pages プロジェクトに割り当てる
# 例: bunx wrangler pages deploy build
```

Pages のビルド設定例:

| 項目 | 値 |
|------|-----|
| Build command | `bun install && bun run build` |
| Build output directory | `build` |
| Environment variable | `VITE_API_BASE = https://<worker-origin>` |

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
| POST | `/api/auth/login` | id/password → 上流ログイン検証 → credential 暗号化保存 → session cookie 発行 |
| POST | `/api/auth/logout` | session cookie 破棄 |
| GET | `/api/auth/me` | ログイン中の userId |
| GET | `/api/notices?type=common\|class&page=1` | LCAM 連絡（透過再ログイン） |
| GET | `/api/notices/detail?type=&index=` | 連絡詳細 |
| GET | `/api/timetable` | LCAM 時間割（SP） |
| GET | `/api/schedule` | LCAM スケジュール（PC 経路） |
| GET | `/api/assignments` | Moodle 課題（token 経由） |
| GET | `/api/syllabus/filters?year=` | シラバス検索フィルタ |
| GET | `/api/syllabus/search?year=&word=&campus=&semester=&week=&hour=&folder=` | シラバス検索 |
| GET | `/api/syllabus/detail?url=` | シラバス詳細 |
| GET | `/api/file/:id` | 添付バイナリ（stream proxy、`:id` は相対 URL の base64url） |

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
- 並行再ログインの直列化・即時失効・keep-alive・自動復旧は実装しない（要件 §11）。
- MFA 導入時は透過再ログインが破綻する。検知してエラーを返すのみ（回復は手動）。
- 上流 HTML 構造は非公式かつ変動し得る。壊れたら手動修正する運用。

## 注意

移植元・本実装とも大学ポータルの非公式スクレイピングであり、上流の利用規約・負荷に
配慮して個人〜知人範囲（数人〜最大10人程度）で利用する前提。
