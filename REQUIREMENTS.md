# 大学ポータル Web 移植 — 要件定義

## 1. 目的

既存の Flutter/Dart アプリ（大学ポータルを非公式スクレイピングで操作）を Web 版へ移植する。ブラウザから直接大学サーバーを叩くと CORS でブロックされるため、Cloudflare Workers をサーバーサイド proxy（BFF）として挟む。ログインの永続化を行い、利用者が毎回 ID/パスワードを入力せずに済む状態を作る。

## 2. 制約・前提

| 項目 | 内容 |
|------|------|
| 課金 | Cloudflare の有料機能は一切使わない。無料枠で完結させる |
| 利用者数 | 数人〜最大10人程度。個人〜知人範囲 |
| 可用性 | 一時的に使えなくなることは許容する。壊れたら手動で修正する運用 |
| 並行制御 | 厳密な直列化・即時失効は要件外（10人規模では実害なし） |
| ホスティング | proxy: Cloudflare Workers / フロント: Cloudflare Pages |

有料前提となる Durable Objects は使用しない。状態は Workers KV に保持する。

## 3. 永続化方式

方式A（認証情報を暗号化保存し、上流セッション失効時に透過再ログインする）を採用する。

- 利用者は初回のみ ID/パスワードを入力する。
- proxy が認証情報を暗号化して KV に保存する。
- 上流セッション失効を検知したら、proxy が保存済み認証情報で自動再ログインしリトライする。
- 体感上は無期限の永続化となる。
- 残存リスク: proxy が侵害されれば復号鍵経由で認証情報が漏れる。方式A採用時点で受容するリスク。

## 4. 通信先（上流3系統）

### 4.1 LCAM（LiveCampus ポータル）
- ホスト: `lcam.aitech.ac.jp`
- 認証: セッション Cookie（JSESSIONID + LiveApps-Cookie）+ Apache Struts CSRF トークン
- データ形式: HTML（パース必須）
- 用途: 連絡・時間割・スケジュール・個人情報
- 透過再ログインの主対象

### 4.2 Moodle（課題）
- ホスト: `cms.aitech.ac.jp`
- 認証: token 方式（`/login/token.php`, `service=moodle_mobile_app`）
- データ形式: JSON（REST API）
- token は長命のため password 非依存で永続化できる。透過再ログインのラップ対象外

### 4.3 シラバス検索
- ホスト: `syllabus.aitech.ac.jp`
- 認証: JSESSIONID のみ（CSRF トークン不要）
- データ形式: HTML
- 状態を持たず、リクエストごとに都度取得する

## 5. アーキテクチャ

```
[browser: SvelteKit SPA]
   │  HttpOnly signed session cookie のみ送信
   ▼
[Cloudflare Workers (Hono): BFF/Router/上流proxy]
   │  session 検証 → credential 復号 → 上流アクセス → 失効検知 → 透過再ログイン
   ▼
[Workers KV: credential 暗号文 + 上流 Cookie / Moodle token]
   │
   ▼
[大学3サーバー: lcam / cms(Moodle) / syllabus]
```

Durable Objects を使わないため、上流セッション管理・再ログイン・credential 復号はすべて Worker のリクエストハンドラ内で完結する。

## 6. データストア（Workers KV）

KV key はユーザー単位で1つにまとめ、1回の read で全状態を取得する（key を分割すると eventual consistency でズレ得るため）。

格納する値（1 key にまとめた JSON、credential 部分は暗号文）:

```typescript
interface UserState {
  // LCAM 上流 Cookie
  lcamCookies: { jsessionid: string; liveApps: string } | null;
  // Moodle token（長命・password非依存）
  moodleToken: string | null;
  // 認証情報（AES-GCM 暗号文）
  credential: { iv: string; ciphertext: string };
}
```

- credential は AES-GCM で暗号化し、暗号文のみ KV に置く。
- 復号は再ログインの瞬間のみメモリ上で行い、平文を保持し続けない。
- KV 書き込み無料枠（1000/日）を浪費しないため、失効検知は保守的に行い再ログインの多発を避ける。

## 7. セッションモデル（browser ↔ proxy）

signed session cookie 方式を採用する。

- cookie 内容: `userId` + 発行時刻を HMAC-SHA256 で署名（`env.SESSION_SECRET`）。
- cookie 属性: `HttpOnly; Secure; SameSite=Strict; Path=/`。
- 認証情報は browser に一切渡さない。XSS で漏れ得るのは session cookie のみで、HttpOnly により JS から読めない。
- 即時失効（全デバイスログアウト）は要件外とする。必要になれば後付けする。

## 8. 透過再ログインのフロー

各上流呼び出しを共通ラッパ経由に統一する。

```
request → 上流fetch
        → 失効検知?  (ログイン画面へのredirect / 特定HTMLパターン / 401)
            no  → レスポンス返却
            yes → 保存済み credential で再ログイン
                → 同一request を1回だけリトライ
                → 再度失効 → 認証失敗として re-auth フローへ（手動修正前提）
```

- LCAM はステータスコードでなく HTML の DOM パターン / リダイレクト先 URL で失効判定する。
- リトライは1回まで。2回目失効は password 変更 / MFA 要求の可能性が高く、無限ループを避けて即エラーへ倒す。
- 並行再ログインの直列化は行わない。同一ユーザーの同時リクエストで二重ログインが起きても、KV を last-write-wins で上書きするだけで実害はない。

## 9. BFF API

browser には正規化済みエンドポイントのみ公開し、上流 URL は隠蔽する。

| メソッド | パス | 内容 |
|----------|------|------|
| POST | `/api/auth/login` | id/password 受領 → 上流ログイン検証 → credential 暗号化保存 → session cookie 発行 |
| POST | `/api/auth/logout` | session cookie 破棄 |
| GET | `/api/notices` | LCAM 連絡（透過再ログイン適用） |
| GET | `/api/timetable` | LCAM 時間割 |
| GET | `/api/schedule` | LCAM スケジュール |
| GET | `/api/performance` | LCAM 成績情報 |
| GET | `/api/enquetes` | LCAM アンケート一覧（授業/授業評価/学内） |
| GET | `/api/enquetes/questions` | 授業アンケートの設問（参照のみ） |
| POST | `/api/enquetes/answer` | 授業アンケート回答の一時保存（実データで検証済み。MIGRATION_NOTES §11） |
| POST | `/api/enquetes/submit` | 授業アンケートの最終提出（確認画面経由の本登録。`confirm` 必須。実データで検証済み。MIGRATION_NOTES §11.5） |
| GET | `/api/assignments` | Moodle 課題（token 経由） |
| GET | `/api/syllabus/search` | シラバス検索（都度 JSESSIONID） |
| GET | `/api/file/:id` | 添付バイナリ（stream proxy） |

- `/api/auth/login` のみ平文 password を受ける。TLS 前提で Worker 内で即暗号化し、browser へは返さない。
- `/api/file/:id` は無料枠のメモリ制限を超えないよう、`Response` body をそのまま pipe して stream proxy する。バッファリングしない。

## 10. 技術スタック

| 層 | 技術 |
|----|------|
| proxy | Cloudflare Workers + Hono + TypeScript |
| ストア | Workers KV |
| HTML パース | node-html-parser |
| 暗号化 | Web Crypto API（AES-GCM） |
| session 署名 | Web Crypto API（HMAC-SHA256） |
| フロント | SvelteKit（Svelte 5） |
| フロント配信 | Cloudflare Pages |

`env.CRED_KEY`（credential 暗号化）と `env.SESSION_SECRET`（session 署名）は Wrangler secret として分離管理する。

## 11. スコープ外 / 簡略化項目

- Durable Objects（有料のため不使用）。
- DO alarm による keep-alive ping（idle timeout は次アクセス時の再ログインで吸収）。
- 即時失効 / 全デバイスログアウト。
- 並行再ログインの厳密な直列化。
- MFA 対応（導入されたら透過再ログインは破綻する。検知してエラーを返すのみ。回復は手動）。
- 自動復旧ロジック全般（壊れたら手動修正する運用）。

## 12. ディレクトリ構成

既存 Dart の `access_*.dart` / `*_parse.dart` 構造を写しやすい形にする。

```
worker/
  src/
    router.ts                 # Hono、session検証・ルーティング・上流proxy
    session/
      cookie.ts               # signed cookie 発行/検証
    store/
      kv.ts                   # UserState の read/write
    crypto/
      aes.ts                  # AES-GCM 暗号化
    upstream/
      relogin.ts              # 透過再ログイン共通ラッパ
      lcam/
        access.ts             # access_lcan.dart 相当
        parse.ts              # lcam_parse.dart 相当
        csrf.ts               # Struts token 抽出
        detect.ts             # 失効検知（DOMパターン/redirect判定）
      moodle/
        access.ts             # access_moodle.dart 相当（JSON）
      syllabus/
        access.ts             # access_syllabus.dart 相当
        parse.ts              # syllabus_parse.dart 相当
    html/
      parser.ts               # node-html-parser ラッパ
  wrangler.toml
web/                          # SvelteKit SPA
```

## 13. セキュリティ

- credential を browser に渡さない。
- session cookie は `HttpOnly; Secure; SameSite=Strict`。
- 状態変更系（login/logout）は Origin チェックを併用する。
- 暗号鍵は env secret で管理し、KV には暗号文のみ置く。
- 受容するリスク: proxy 侵害時の credential 漏洩（方式A の本質）。Cloudflare 側のアクセス制御に依存して緩和する。

## 14. 実装前に確認する事項

- Workers KV / Pages の無料枠日次上限は変動するため、実装前に Cloudflare 現行ドキュメントで確認する。
- 既存 Dart 実装（`access_*.dart`, `*_parse.dart`, `get_lcam_data.dart`, `login.dart`, `identity_provider.dart`）の具体ロジックを移植元として参照する。
