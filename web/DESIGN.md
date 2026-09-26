# aitapp-web デザインシステム / コンポーネント / ページ仕様

web/（SvelteKit + Svelte 5）の UI を体系化するための確定仕様。
既存実装（`src/app.css` のトークン、`src/lib/components/`、`src/lib/views/`)を土台に、
不足しているトークン・コンポーネント・ページを列挙する。
ダミーデータは [src/lib/dummy.ts](src/lib/dummy.ts) に集約する（`shared/contract.ts` 準拠）。

---

## 0. デザイン原則

1. **モバイルファースト**。基準幅 `--app-max: 480px`。デスクトップ（≥768px）は SideNav + 余白拡張のみで、レイアウトを作り分けない。
2. **「今日なにをすべきか」を最短で見せる**。Home は今日の授業・直近の締切・重要連絡の3ブロック構成。
3. **上流（LCAM/Moodle/シラバス）の情報を削らず整形する**。パース結果のフィールドは原則すべて表示可能にする。
4. **過剰実装しない**。ダークモード・アニメーションライブラリ・CSS フレームワーク導入はスコープ外。素の CSS + CSS 変数で完結する。
5. **失敗を隠さない**。ApiError の `message` と `correlationId` を必ずユーザーに見せる（問い合わせ時のログ突合用）。

---

## 1. デザイントークン（`src/app.css` を拡張）

### 1.1 カラー

| 変数 | 値 | 用途 |
|---|---|---|
| `--primary` | `#006fff` | アクション・リンク・アクティブ状態・土曜日 |
| `--primary-light` | `#83b9ff` | ナビバー背景・時限ラベル・タグ |
| `--primary-pale` | `#9fc9ff` | 隣月日付などの淡色 |
| `--primary-bg` | `#e2eeff` | 選択行背景・強調背景 |
| `--navy` | `#003a87` | 見出し・平日日付 |
| `--red` | `#ff0051` | 日曜・祝日 |
| `--orange` | `#ff8000` | 予定ありドット・重要マーク |
| `--bg` | `#f4f7fb` | ページ背景 |
| `--card` | `#ffffff` | カード背景 |
| `--fg` | `#1a2433` | 本文 |
| `--muted` | `#6b7a90` | 補足テキスト |
| `--border` | `#e2e8f0` | 罫線 |
| `--danger` | `#dc2626` | エラー・破壊的操作 |
| `--important` | `#ff8000` | 重要連絡バッジ |

**追加するセマンティックトークン**（新規）:

| 変数 | 値 | 用途 |
|---|---|---|
| `--success` | `#16a34a` | 提出済み・回答済みバッジ |
| `--warning-bg` | `#fff7ed` | 締切接近カード背景 |
| `--danger-bg` | `#fef2f2` | エラーバナー背景 |
| `--success-bg` | `#f0fdf4` | 完了バナー背景 |
| `--overlay` | `rgba(16,36,64,.45)` | Sheet/Modal の背面 |

### 1.2 タイポグラフィ

フォントは既存の `'Noto Sans JP', system-ui, …` を維持。スケールを変数化する（新規）:

| 変数 | サイズ/行高 | 用途 |
|---|---|---|
| `--text-display` | 24px / 1.35 bold | Home の挨拶・ページ大見出し |
| `--text-title` | 20px / 1.4 bold | ページタイトル |
| `--text-heading` | 17px / 1.45 bold | セクション見出し・カードタイトル |
| `--text-body` | 15px / 1.6 | 本文 |
| `--text-caption` | 13px / 1.5 | 補足・メタ情報 |
| `--text-micro` | 11px / 1.4 | バッジ・タブラベル |

数字（時限・日付・カウントダウン）は `font-variant-numeric: tabular-nums` を適用する。

### 1.3 スペーシング / 形状 / 影 / 動き

- スペーシング: 4px ベース。`--sp-1: 4px` 〜 `--sp-6: 32px`（新規変数化）。ページ左右パディングは 16px（モバイル）/ 32px（デスクトップ）。
- 角丸: 既存 `--radius: 14px`（カード）/ `--radius-sm: 8px`（バッジ・入力）。追加 `--radius-full: 999px`（チップ・BottomNav）。
- 影: 既存 `--shadow`（カード）。追加 `--shadow-nav: 0 8px 24px rgba(0,111,255,.28)`（BottomNav、既存値の変数化）。
- モーション: `--dur: .18s; --ease: ease`。Sheet のスライドインは `.24s`。`prefers-reduced-motion` で無効化。
- z-index: `--z-nav: 50`（既存 BottomNav）/ `--z-sheet: 60` / `--z-modal: 70` / `--z-toast: 80`。

### 1.4 ブレークポイント

| 名前 | 条件 | 挙動 |
|---|---|---|
| mobile | `< 768px` | BottomNav・1カラム・`--app-max` 中央寄せ |
| desktop | `≥ 768px`（`isDesktop` 判定含む） | SideNav（幅 220px 固定）・main は `margin-left: 220px` |

CSS での書き分け（定義は `vite.config.ts` と `src/app.css` 冒頭）:

```css
/* 構造が変わる: (--desktop) / (--mobile)。Svelte の <style> 内でも使える */
@media (--desktop) { .shell { display: flex; } }

/* 値だけ違う: --d は mobile=0 / desktop=1 */
padding: calc(16px + 16px * var(--d));   /* または var(--page-pad) */
```

```svelte
<!-- 表示の出し分け -->
<nav class="mobile-only">…</nav>
<aside class="desktop-only">…</aside>
```

Tauri 版は `(--desktop)` / `(--mobile)` がビルド種別で固定される（ウィンドウ幅に依存しない）。

---

## 2. コンポーネント一覧

凡例: ✅=既存（`src/lib/components/`）、🆕=新規作成。

### 2.1 基盤（Foundation）

| コンポーネント | 状態 | Props / 備考 |
|---|---|---|
| `Icon` | ✅ | `name, size, color`。SVG インライン。タブ・行頭アイコン共通 |
| `Spinner` | 🆕 | `size`。単純な回転円。ボタン内ローディングにも流用 |
| `Skeleton` | 🆕 | `variant: 'line' \| 'card' \| 'row'`, `count`。一覧の初期ロードに使用 |
| `EmptyState` | 🆕 | `icon, title, description`。「連絡はありません」等 |
| `ErrorState` | 🆕 | `error: ApiError, onRetry`。message + correlationId + 再試行ボタン。401 は login へ誘導 |
| `Badge` | 🆕 | `variant: 'important' \| 'success' \| 'danger' \| 'neutral' \| 'primary'`。重要/提出済み/締切超過など |
| `Chip` | 🆕 | `selected, onclick`。シラバス検索のフィルタ選択に使用 |

### 2.2 入力（Input）

| コンポーネント | 状態 | Props / 備考 |
|---|---|---|
| `Button` | 🆕 | `variant: 'primary' \| 'secondary' \| 'ghost' \| 'danger'`, `size: 'md' \| 'lg'`, `loading, disabled`。既存各ビューのインラインボタンを統合 |
| `TextField` | 🆕 | `label, type, value, error, autocomplete`。login とアンケート回答欄で使用。`maxLength` 対応（EnqueteQuestion.maxLength） |
| `SearchField` | 🆕 | `value, placeholder, onSubmit`。シラバスのキーワード検索 |
| `Select` | 🆕 | `label, options: Record<string,string>, value`。シラバスフィルタ（年度・学期・曜日・時限・キャンパス・分類） |
| `SegmentedControl` | 🆕 | `options, value`。連絡の「大学からの連絡 / 授業連絡」切替、アンケート種別切替 |

### 2.3 レイアウト / フィードバック

| コンポーネント | 状態 | Props / 備考 |
|---|---|---|
| `Card` | 🆕 | `padding, onclick?`。`--card` 背景 + `--radius` + `--shadow` の統一箱。各ビューの重複 CSS を吸収 |
| `ListRow` | 🆕 | `title, subtitle, meta, badge?, chevron?`。連絡・課題・シラバス結果の共通行 |
| `SectionHeader` | 🆕 | `title, action?`。「今日の授業」「直近の締切」+ 「すべて見る」リンク |
| `PageHeader` | 🆕 | `title, back?`。More 配下のサブページ用（戻るボタン付き） |
| `Sheet` | ✅ | ボトムシート。連絡詳細・シラバス詳細で使用中。`--z-sheet` へ統一 |
| `ConfirmDialog` | 🆕 | `title, message, confirmLabel, danger?`。**アンケート最終提出（取り消し不可）とログアウトで必須**。confirm 必須 API と対で使う |
| `Toast` | 🆕 | `message, variant: 'success' \| 'error'`。一時保存完了・提出完了・コピー完了の通知 |

### 2.4 ナビゲーション

| コンポーネント | 状態 | Props / 備考 |
|---|---|---|
| `BottomNav` | ✅ | 5タブ（お知らせ/カレンダー/ホーム/課題/その他）。モバイルのみ |
| `SideNav` | ✅ | デスクトップのみ。BottomNav と同一タブ集合 |

### 2.5 ドメイン固有

| コンポーネント | 状態 | データ型 | 備考 |
|---|---|---|---|
| `NoticeRow` | 🆕 | `Notice` | ListRow 特化。`isImportant` → Badge、`ClassNotice` は科目名表示 |
| `AssignmentCard` | 🆕 | `Assignment` | コース名・締切カウントダウン（「あと2日」）。締切24h以内は `--warning-bg`、超過は `--danger` 打ち消し表示。`dueDate: null` は「締切なし」 |
| `TimetableGrid` | 🆕 | `TimetableEntry[]` | 曜日×時限（1..7）グリッド。セル = 科目/教室/教員。現在コマをハイライト |
| `PeriodItem` | 🆕 | `TimetableEntry` | Home「今日の授業」用の1行表示（時限バッジ + 科目 + 教室） |
| `MonthCalendar` | ✅ | `ScheduleDay[]` | 月グリッド。予定ありドット（`--orange`）、日曜 `--red`・土曜 `--primary` |
| `DayEventList` | 🆕 | `ScheduleEvent[]` | 選択日のイベント一覧。時刻・場所・教員 |
| `SyllabusResultRow` | 🆕 | `SyllabusListItem` | 科目・教員・分類・単位数 |
| `SyllabusDetailView` | 🆕 | `SyllabusDetail` | セクション積み（授業内容/計画/到達目標/成績評価/教科書…）。`plan[]` は番号付きリスト |
| `GradeTable` | 🆕 | `PerformanceEntry[]` | カテゴリ見出しでグループ化。評価バッジ（秀/優/良/可/不可を色分け）。`inProgress` は「履修中」表示 |
| `GradeSummary` | 🆕 | 集計値 | 修得単位合計・GPA 風の一覧上部サマリー（クライアント側集計のみ） |
| `EnqueteRow` | 🆕 | `EnqueteListItem` | `fields` の科目・期限などを表示。回答状況バッジ |
| `EnqueteForm` | 🆕 | `EnqueteQuestion[]` | 設問リスト + TextField。`answerType: 'unsupported'` の設問は「この形式は Web 版では未対応」表示で送信不可にする |
| `McpTokenPanel` | 🆕 | — | More 内。発行/再発行/失効。**平文トークンは発行応答でのみ表示**、コピー用ボタン + 「再表示不可」の注意書き |

---

## 3. ページ一覧

ルーティング: タブはパスで管理する（`/` ホーム、`/notices`、`/calendar`、`/assignments`、`/more`）。
`src/routes/(app)/+layout.svelte` が認証チェック・BottomNav / SideNav・各タブのビューを持つ
（各 `+page.svelte` は空）。ナビの DOM はタブ遷移でも再生成されず、BottomNav の青い丸が選択中の
項目へスライドする。開いたタブのビューは破棄せず保持し（読み込み済みデータ・入力状態・スクロール位置を残す）、
切替時はナビの並び順に従って左右にスライドする。ビューは再びアクティブになるたびに
`onActivate`（`$lib/activate.svelte.ts`）で裏から取り直し、結果が変わったときだけ表示を差し替える。
タブ⇄パスの対応と並び順は `$lib/tabs.ts`。`/login` と `/syllabus` は (app) の外。More 配下のサブビューは
`/more` 内のビュー切替（Sheet またはビュースタック）で実装し、URL は増やさない。

### 3.1 `/login` — ログイン

- 中央寄せ 1 カード。アプリ名 + 学籍番号 `TextField` + パスワード `TextField(type=password)` + `Button(primary, lg, loading)`。
- 失敗時: カード内に `--danger-bg` バナーでエラー文言（上流認証失敗 / 通信エラーを区別）。
- 注意書き: 「認証情報は暗号化して保存され、ブラウザには保持されません」。
- 状態: idle / submitting（ボタン loading + 入力 disabled）/ error。

### 3.2 Home タブ（`Home.svelte`）

構成（上から）:
1. 挨拶ヘッダ: 「こんにちは、`userId` さん」+ 今日の日付（`--text-display`）。
2. **今日の授業** `SectionHeader`（→ 時間割へ）: `PeriodItem` 縦積み。今日の `TimetableEntry` を時限順。0件なら EmptyState「今日の授業はありません」。
3. **直近の締切** `SectionHeader`（→ 課題タブへ）: 締切が近い順に `AssignmentCard` 最大3件。
4. **重要なお知らせ**: `isImportant` な `Notice` 最大3件の `NoticeRow`。
- 状態: 各セクション独立に Skeleton → データ / EmptyState / ErrorState（1つの上流失敗で全体を壊さない）。

### 3.3 お知らせタブ（`Notices.svelte`）

- `SegmentedControl`: 「大学からの連絡」(`common`) / 「授業連絡」(`class`)。
- `NoticeRow` リスト。ClassNotice は科目名 + 補講日（`makeupClassAt`）をメタ表示。
- 行タップ → `Sheet` で `NoticeDetail`: 差出人・日時・本文・URL リンク列・添付 `files`（`/api/file/:id` 経由、`fileUrl()`）。
- 状態: Skeleton(row×8) / EmptyState / ErrorState。詳細取得中は Sheet 内 Spinner。

### 3.4 カレンダータブ（`Calendar.svelte`）

- 上部: `MonthCalendar`（月送り ‹ › + 今日ボタン）。
- 下部: 選択日の `DayEventList`。イベント0件は「予定はありません」。
- LCAM スケジュールの取得範囲外の月は「この月の予定は取得できません」注記。

### 3.5 課題タブ（`Assignments.svelte`）

- ソート: 締切昇順（締切なしは末尾）。
- `AssignmentCard` 縦積み。コース名でのグルーピングはしない（一覧性優先）。
- フィルタチップ（任意・後回し可）: 「7日以内」「締切なし」。
- Moodle token 失効時: ErrorState に「再ログインで復旧します」文言。

### 3.6 その他タブ（`More.svelte`）— ハブ

`ListRow` メニュー: 時間割 / スケジュール一覧 / シラバス検索 / 成績 / アンケート / MCP 連携 / ログアウト。
以下はここから開くサブビュー（`PageHeader` で戻る）。

#### 3.6.1 時間割（`Timetable.svelte`）

- `TimetableGrid`。モバイルは横スクロール可、デスクトップは全曜日表示。
- 今日の列 + 現在時限セルを `--primary-bg` でハイライト。

#### 3.6.2 スケジュール一覧（`Schedule.svelte`）

- `ScheduleDay[]` を日付見出し + `DayEventList` で縦積み（カレンダーのリスト版）。

#### 3.6.3 シラバス検索（`Syllabus.svelte`）

- 検索フォーム: `SearchField` + `Select`×（年度/分類/キャンパス/学期/曜日/時限）。`syllabusFilters` の `Record<string,string>` をそのまま options に。
- 結果: `SyllabusResultRow` リスト + 件数表示。
- 行タップ → `Sheet` で `SyllabusDetailView`。
- 状態: 未検索（説明文）/ 検索中 Skeleton / 0件 EmptyState / ErrorState。

#### 3.6.4 成績（新規 `Grades.svelte`）

- API: `GET /api/performance`（`ApiClient` に `performance()` を追加する。型は `PerformanceEntry` を `shared/contract.ts` へ昇格）。
- 上部 `GradeSummary`（修得単位合計・履修中単位）+ `GradeTable`（category ごとにセクション）。
- 評価の色: 秀/S=`--primary`、優/A=`--success`、良/B=`--fg`、可/C=`--muted`、不可/D・F=`--danger`、履修中=`--orange`。

#### 3.6.5 アンケート（新規 `Enquetes.svelte`）

- API: `GET /api/enquetes?type=…` / `GET /api/enquetes/questions` / `POST /api/enquetes/answer` / `POST /api/enquetes/submit`（`ApiClient` へ追加）。
- 一覧: `SegmentedControl`（授業 / 授業評価 / 学内）+ `EnqueteRow`。授業評価・学内は閲覧のみ（回答導線を出さない）。
- 回答画面: `EnqueteForm`。フッターに `Button(secondary)「一時保存」` と `Button(primary)「提出へ」`。
- 提出フロー: 「提出へ」→ `ConfirmDialog`（**「提出後は修正できません」+ danger 色**）→ 確定で `submit`（confirm 必須 API）→ `Toast(success)`。
- 一時保存成功も `Toast` で通知。

#### 3.6.6 MCP 連携（More 内セクション）

- `McpTokenPanel`。未発行: 説明 + 発行ボタン。発行直後: URL 全文 + コピー + 「この URL は今だけ表示されます」。発行済み: 状態表示 + 再発行 / 失効（`ConfirmDialog` 経由）。

### 3.7 共通状態パターン

| 状態 | 表現 |
|---|---|
| 初期ロード | `Skeleton`（レイアウト形状に一致させる） |
| 空 | `EmptyState`（アイコン + 一言 + 補足） |
| エラー | `ErrorState`（message / correlationId / 再試行）。`status===401` は `/login` へ |
| 再ログイン失敗（2回目失効） | ErrorState + 「時間をおいて再度ログインしてください」 |
| 書き込み成功 | `Toast(success)` |
| 取り消し不可操作 | 必ず `ConfirmDialog` を経由 |

---

## 4. ダミーデータ

[src/lib/dummy.ts](src/lib/dummy.ts) に `shared/contract.ts` 準拠のダミーを集約。
成績（`PerformanceEntry`）とアンケートは worker の `upstream/lcam/parse.ts` の型に合わせた暫定型を同ファイルに置く
（contract 昇格時に import へ差し替え）。

用途:
- 各コンポーネントの実装・目視確認（ログイン不要でビューを組める）。
- Skeleton/Empty/Error 以外の「データあり」状態の見た目確認。

**ダミーデータを本番ビルドのフォールバックに使わない**（エラーはエラーとして見せる原則に反するため）。
