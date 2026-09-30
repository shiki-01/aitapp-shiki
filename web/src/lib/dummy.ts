// デザイン・コンポーネント実装用のダミーデータ集。
// 型は shared/contract.ts を単一情報源とする。成績・アンケートは contract 未昇格のため
// worker/src/upstream/lcam/parse.ts の型に合わせた暫定型をここに置く（昇格時に import へ差し替え）。
// 本番コードのフォールバックには使わない（DESIGN.md 第4節）。

import type {
  Notice,
  NoticeDetail,
  TimetableEntry,
  ScheduleDay,
  Assignment,
  SyllabusFilters,
  SyllabusListItem,
  SyllabusDetail,
  CommonFileItem,
  CommonFileDetail,
  ReportItem,
  ReportDetail,
  FacilityItem,
  FacilityWeek,
  CreditStatus,
  CurriculumItem,
  SchoolEvents,
  LotteryResult,
  PcNoticeList,
  PcNoticeDetail,
  StaffMember,
} from '../../../shared/contract';

// ---- 連絡（LCAM） ----

export const dummyUnivNotices: Notice[] = [
  {
    type: 'common',
    sender: '教務課',
    title: '【重要】前期末試験の時間割公開について',
    sendAt: '2026-07-21 10:00',
    isImportant: true,
    index: 0,
  },
  {
    type: 'common',
    sender: '学生課',
    title: '夏季休業期間中の窓口業務について',
    sendAt: '2026-07-18 15:30',
    isImportant: false,
    index: 1,
  },
  {
    type: 'common',
    sender: '情報教育センター',
    title: '計算機演習室 定期メンテナンスのお知らせ（8/1-8/3）',
    sendAt: '2026-07-15 09:00',
    isImportant: false,
    index: 2,
  },
  {
    type: 'common',
    sender: 'キャリアセンター',
    title: '3年生対象 インターンシップ説明会の開催について',
    sendAt: '2026-07-10 13:00',
    isImportant: false,
    index: 3,
  },
];

export const dummyClassNotices: Notice[] = [
  {
    type: 'class',
    sender: '山田 太郎',
    title: '第14回 講義資料の訂正について',
    subject: 'データ構造とアルゴリズム',
    makeupClassAt: '',
    isImportant: true,
    index: 0,
  },
  {
    type: 'class',
    sender: '佐藤 花子',
    title: '補講の実施について',
    subject: 'コンピュータネットワーク',
    makeupClassAt: '2026-07-29 3限',
    isImportant: false,
    index: 1,
  },
  {
    type: 'class',
    sender: '鈴木 一郎',
    title: 'レポート提出方法の変更',
    subject: 'ソフトウェア工学',
    makeupClassAt: '',
    isImportant: false,
    index: 2,
  },
];

export const dummyNoticeDetail: NoticeDetail = {
  sender: '教務課',
  title: '【重要】前期末試験の時間割公開について',
  content:
    '前期末試験の時間割を公開しました。\n試験期間は 8月3日（月）〜 8月7日（金）です。\n\n受験上の注意:\n・学生証を必ず持参してください。\n・試験開始20分以降の入室は認められません。\n・詳細は添付ファイルを確認してください。',
  sendAt: '2026-07-21 10:00',
  url: ['https://www.example.ac.jp/exam/2026-spring'],
  files: { '前期末試験時間割.pdf': 'file/12345', '受験上の注意.pdf': 'file/12346' },
};

// ---- 連絡: レイアウト確認用の「全項目入り」通知 ----
// Notices.svelte が一覧先頭に強制挿入する（DEBUG_FORCE_FULL_NOTICE で切替）。
// 上流が返し得る全フィールド・長文・改行・リスト・表・リンク・複数添付を詰めてある。
export const FULL_NOTICE_INDEX = -1;

export const fullUnivNotice: Notice = {
  type: 'common',
  sender: '教務課（前期末試験・成績・履修登録に関する窓口担当）',
  title:
    '【重要】【再周知】2026年度 前期末試験の時間割・受験上の注意・追試験の申請方法および成績発表日程について（全学年対象・必ずお読みください）',
  sendAt: '2026-07-21 10:00',
  isImportant: true,
  index: FULL_NOTICE_INDEX,
};

export const fullClassNotice: Notice = {
  type: 'class',
  sender: '山田 太郎（情報工学科 教授・データ構造とアルゴリズム担当）',
  title:
    '【重要】第14回 講義資料の訂正と補講の実施、および期末レポートの提出方法変更について（受講者全員必読）',
  subject: 'データ構造とアルゴリズム（月3・月4／情報工学科 2年 前期）',
  makeupClassAt: '2026-07-29 3限（4-301教室）',
  isImportant: true,
  index: FULL_NOTICE_INDEX,
};

const fullContent = `
<h3>1. 概要</h3>
<p>前期末試験の時間割を公開しました。<b>必ず本文の全項目を確認</b>してください。<br>
試験期間は <strong>8月3日（月）〜 8月7日（金）</strong>です。<font color="#d32f2f">日程の変更は原則ありません。</font></p>
<hr>
<h3>2. 試験時間割（抜粋）</h3>
<table>
  <caption>前期末試験 時間割</caption>
  <thead><tr><th>日付</th><th>1限</th><th>2限</th><th>3限</th></tr></thead>
  <tbody>
    <tr><td>8/3（月）</td><td>線形代数II</td><td>確率統計</td><td>データ構造とアルゴリズム</td></tr>
    <tr><td>8/4（火）</td><td>技術英語I</td><td>コンピュータネットワーク</td><td>ソフトウェア工学</td></tr>
    <tr><td colspan="2" align="center">8/5（水）</td><td colspan="2" align="center">オペレーティングシステム</td></tr>
  </tbody>
</table>
<h3>3. 受験上の注意</h3>
<ul>
  <li>学生証を<u>必ず</u>持参してください（忘れた場合は仮受験票を発行します）。</li>
  <li>試験開始<em>20分以降</em>の入室は認められません。</li>
  <li>持ち込み可の物: <code>電卓（関数電卓不可）</code>、筆記用具、時計（通信機能なし）。
    <ul><li>スマートフォンは電源を切り、鞄にしまうこと。</li><li>不正行為は<s>厳重注意</s>単位認定の取り消し対象です。</li></ul>
  </li>
</ul>
<h3>4. 追試験の申請手順</h3>
<ol>
  <li>教務課窓口で申請書を受け取る</li>
  <li>理由を証明する書類を添付する</li>
  <li>試験日の<b>3日前</b>までに提出する</li>
</ol>
<blockquote>やむを得ない事情（病気・忌引き・公共交通機関の遅延等）がある場合は、事前に教務課へ相談してください。</blockquote>
<dl>
  <dt>問い合わせ先</dt><dd>教務課 試験係（内線 1234／平日 9:00–17:00）</dd>
  <dt>メール</dt><dd>exam@example.ac.jp</dd>
</dl>
<pre>
成績発表: 2026-08-28 12:00
異議申立: 2026-08-28 〜 2026-09-01
</pre>
<p>H<sub>2</sub>O や x<sup>2</sup> のような添字、<small>小さな注記（この行は補足です）</small>も表示されます。</p>
<center>― 以上 ―</center>
<p>詳細は https://www.example.ac.jp/exam/2026-spring/guide?lang=ja&amp;year=2026 を参照してください。</p>
<p>長い連続文字列の折り返し確認: ${'ＡＢＣＤＥＦＧＨＩＪ'.repeat(8)}</p>
`.trim();

export const fullNoticeDetail: NoticeDetail = {
  sender: '教務課（前期末試験・成績・履修登録に関する窓口担当）',
  title: fullUnivNotice.title,
  content: fullContent,
  sendAt: '2026-07-21 10:00',
  subject: 'データ構造とアルゴリズム（月3・月4／情報工学科 2年 前期）',
  url: [
    'https://www.example.ac.jp/exam/2026-spring',
    'https://www.example.ac.jp/exam/2026-spring/guide?lang=ja&year=2026&faculty=engineering&dept=information&grade=2&semester=first&notice=important',
    'https://forms.example.ac.jp/makeup-exam-application',
  ],
  files: {
    '前期末試験時間割.pdf': 'file/12345',
    '受験上の注意.pdf': 'file/12346',
    '【2026年度】前期末試験_追試験申請書（記入例つき）_情報工学科・電子工学科・機械工学科共通版_最終確定版.docx': 'file/12347',
    '成績評価基準.xlsx': 'file/12348',
    'slides_14_corrected.pptx': 'file/12349',
    'ファイル名に拡張子なし': 'file/12350',
  },
};

// ---- 時間割（LCAM） ----

export const dummyTimetable: TimetableEntry[] = [
  { day: 'monday', period: 1, title: '線形代数II', location: '2-201', teacher: '高橋 誠' },
  { day: 'monday', period: 3, title: 'データ構造とアルゴリズム', location: '4-301', teacher: '山田 太郎' },
  { day: 'monday', period: 4, title: 'データ構造とアルゴリズム演習', location: '計算機演習室A', teacher: '山田 太郎' },
  { day: 'tuesday', period: 2, title: 'コンピュータネットワーク', location: '3-102', teacher: '佐藤 花子' },
  { day: 'tuesday', period: 4, title: '技術英語I', location: '1-105', teacher: 'Smith J.' },
  { day: 'wednesday', period: 1, title: '確率統計', location: '2-203', teacher: '伊藤 健' },
  { day: 'wednesday', period: 3, title: 'ソフトウェア工学', location: '4-201', teacher: '鈴木 一郎' },
  { day: 'thursday', period: 2, title: 'オペレーティングシステム', location: '3-301', teacher: '渡辺 隆' },
  { day: 'thursday', period: 5, title: 'キャリアデザイン', location: '大講義室', teacher: '中村 由美' },
  { day: 'friday', period: 1, title: 'データベース', location: '4-102', teacher: '小林 修' },
  { day: 'friday', period: 2, title: 'データベース演習', location: '計算機演習室B', teacher: '小林 修' },
];

// ---- スケジュール（LCAM） ----

export const dummySchedule: ScheduleDay[] = [
  {
    date: '2026-07-22',
    events: [
      {
        title: 'コンピュータネットワーク',
        startTime: '2026-07-22T10:40',
        endTime: '2026-07-22T12:10',
        location: '八草 3-102',
        roomId: '3-102',
        teacher: '佐藤 花子',
        period: 2,
      },
      {
        title: '技術英語I',
        startTime: '2026-07-22T14:50',
        endTime: '2026-07-22T16:20',
        location: '八草 1-105',
        roomId: '1-105',
        teacher: 'Smith J.',
        period: 4,
      },
    ],
  },
  {
    date: '2026-07-24',
    events: [
      {
        title: 'オペレーティングシステム（最終回）',
        startTime: '2026-07-24T10:40',
        endTime: '2026-07-24T12:10',
        location: '八草 3-301',
        roomId: '3-301',
        teacher: '渡辺 隆',
        period: 2,
      },
    ],
  },
  {
    date: '2026-08-03',
    events: [
      {
        title: '前期末試験: データ構造とアルゴリズム',
        startTime: '2026-08-03T09:00',
        endTime: '2026-08-03T10:00',
        location: '八草 4-301',
        roomId: '4-301',
      },
    ],
  },
];

// ---- 課題（Moodle） ----

export const dummyAssignments: Assignment[] = [
  {
    id: 101,
    name: '最終レポート: ダイクストラ法の実装と考察',
    description: '<p>最短経路アルゴリズムを実装し、計算量について考察せよ。</p>',
    dueDate: '2026-07-24T23:59:00+09:00',
    dueEpochMs: Date.parse('2026-07-24T23:59:00+09:00'),
    cutoffDate: '2026-07-27T23:59:00+09:00',
    cutoffEpochMs: Date.parse('2026-07-27T23:59:00+09:00'),
    courseId: 11,
    courseName: 'データ構造とアルゴリズム',
  },
  {
    id: 102,
    name: '第13回 小テスト（TCP/IP）',
    description: '',
    dueDate: '2026-07-23T12:10:00+09:00',
    dueEpochMs: Date.parse('2026-07-23T12:10:00+09:00'),
    cutoffDate: null,
    cutoffEpochMs: 0,
    courseId: 12,
    courseName: 'コンピュータネットワーク',
  },
  {
    id: 103,
    name: '要求仕様書の提出',
    description: '<p>グループで作成した要求仕様書を代表者が提出すること。</p>',
    dueDate: '2026-07-31T23:59:00+09:00',
    dueEpochMs: Date.parse('2026-07-31T23:59:00+09:00'),
    cutoffDate: null,
    cutoffEpochMs: 0,
    courseId: 13,
    courseName: 'ソフトウェア工学',
  },
  {
    id: 104,
    name: '自由課題: SQL チューニングレポート',
    description: '',
    dueDate: null,
    dueEpochMs: 0,
    cutoffDate: null,
    cutoffEpochMs: 0,
    courseId: 14,
    courseName: 'データベース',
  },
];

// ---- シラバス ----

export const dummySyllabusFilters: SyllabusFilters = {
  year: { '2026': '2026年度', '2025': '2025年度' },
  folder: { '01': '共通教育', '02': '工学部', '03': '情報科学部', '04': '経営学部' },
  campus: { '1': '八草', '2': '本山', '3': '自由ヶ丘' },
  hour: { '1': '1限', '2': '2限', '3': '3限', '4': '4限', '5': '5限', '6': '6限', '7': '7限' },
  week: { '1': '月', '2': '火', '3': '水', '4': '木', '5': '金', '6': '土' },
  semester: { '1': '前期', '2': '後期' },
};

export const dummySyllabusResults: SyllabusListItem[] = [
  {
    unitsNumber: 2,
    classification: '専門・必修',
    teacher: '山田 太郎',
    subject: 'データ構造とアルゴリズム',
    url: '/syllabus/2026/detail/1101',
  },
  {
    unitsNumber: 1,
    classification: '専門・必修',
    teacher: '山田 太郎',
    subject: 'データ構造とアルゴリズム演習',
    url: '/syllabus/2026/detail/1102',
  },
  {
    unitsNumber: 2,
    classification: '専門・選択',
    teacher: '小林 修',
    subject: 'データベース',
    url: '/syllabus/2026/detail/1201',
  },
];

export const dummySyllabusDetail: SyllabusDetail = {
  unitsNumber: 2,
  classification: '専門・必修',
  teachers: [{ name: '山田 太郎', ruby: 'やまだ たろう' }],
  semester: '前期',
  subject: 'データ構造とアルゴリズム',
  classPeriod: '月曜 3限',
  classRoom: '4-301',
  content: [
    '基本的なデータ構造（配列・連結リスト・スタック・キュー・木・グラフ）を学ぶ。',
    '代表的なアルゴリズム（整列・探索・最短経路）の設計と計算量解析を行う。',
  ],
  plan: [
    'ガイダンス / 計算量の基礎',
    '配列と連結リスト',
    'スタックとキュー',
    '再帰とアルゴリズム設計',
    '整列アルゴリズム(1) 単純整列',
    '整列アルゴリズム(2) クイックソート・マージソート',
    '中間まとめと演習',
    '木構造と二分探索木',
    'ヒープと優先度付きキュー',
    'ハッシュ法',
    'グラフの表現と探索',
    '最短経路アルゴリズム',
    '動的計画法入門',
    '総合演習',
    '期末試験と解説',
  ],
  learningGoal: '基本データ構造を適切に選択し、計算量を意識したプログラムを設計・実装できる。',
  features: '毎回の講義に対応する演習課題を Moodle で出題する。',
  records: '期末試験 60% / 演習課題 30% / 小テスト 10%',
  teachersMessage: '手を動かして実装することが理解への近道です。',
  textBook: '『アルゴリズムとデータ構造』（例示出版, 2024）',
  referenceBook: '『プログラミングコンテスト攻略のためのアルゴリズム』（例示社）',
};

// ---- 成績（LCAM /api/performance） ----
// 暫定型: worker/src/upstream/lcam/parse.ts の PerformanceEntry と同形。
// shared/contract.ts へ昇格したら import へ差し替える。

export interface DummyPerformanceEntry {
  category: string;
  subject: string;
  teacher: string;
  year: string;
  semester: string;
  credits: number | null;
  grade: string;
  inProgress: boolean;
}

export const dummyPerformance: DummyPerformanceEntry[] = [
  { category: '共通教育科目', subject: '技術英語I', teacher: 'Smith J.', year: '2026', semester: '前期', credits: 1, grade: '', inProgress: true },
  { category: '共通教育科目', subject: '基礎数学', teacher: '高橋 誠', year: '2025', semester: '前期', credits: 2, grade: '優', inProgress: false },
  { category: '共通教育科目', subject: '物理学基礎', teacher: '田中 実', year: '2025', semester: '後期', credits: 2, grade: '良', inProgress: false },
  { category: '専門科目', subject: 'プログラミング入門', teacher: '山田 太郎', year: '2025', semester: '前期', credits: 2, grade: '秀', inProgress: false },
  { category: '専門科目', subject: '計算機アーキテクチャ', teacher: '渡辺 隆', year: '2025', semester: '後期', credits: 2, grade: '優', inProgress: false },
  { category: '専門科目', subject: '離散数学', teacher: '伊藤 健', year: '2025', semester: '後期', credits: 2, grade: '可', inProgress: false },
  { category: '専門科目', subject: 'データ構造とアルゴリズム', teacher: '山田 太郎', year: '2026', semester: '前期', credits: 2, grade: '', inProgress: true },
];

// ---- アンケート（LCAM /api/enquetes） ----
// 暫定型: worker/src/upstream/lcam/parse.ts の EnqueteListItem / EnqueteQuestion と同形。

export interface DummyEnqueteListItem {
  fields: Record<string, string>;
}

export const dummyEnqueteList: DummyEnqueteListItem[] = [
  {
    fields: {
      科目: 'データ構造とアルゴリズム',
      教員: '山田 太郎',
      実施期間: '2026/07/13 〜 2026/07/27',
      回答状況: '未回答',
    },
  },
  {
    fields: {
      科目: 'コンピュータネットワーク',
      教員: '佐藤 花子',
      実施期間: '2026/07/13 〜 2026/07/27',
      回答状況: '回答済',
    },
  },
];

export interface DummyEnqueteQuestion {
  index: number;
  label: string;
  prompt: string;
  maxLength: number | null;
  answerType: 'text' | 'unsupported';
  fieldName: string;
}

export const dummyEnqueteQuestions: DummyEnqueteQuestion[] = [
  {
    index: 1,
    label: 'ア',
    prompt: 'この授業で最も理解が深まった内容を記入してください。',
    maxLength: 200,
    answerType: 'text',
    fieldName: 'value1',
  },
  {
    index: 2,
    label: 'イ',
    prompt: '授業の進め方について改善してほしい点があれば記入してください。',
    maxLength: 200,
    answerType: 'text',
    fieldName: 'value2',
  },
  {
    index: 3,
    label: 'ウ',
    prompt: '総合満足度を選択してください。',
    maxLength: null,
    answerType: 'unsupported',
    fieldName: 'value3',
  },
];

// ---- 集約（ビュー実装時の取り回し用） ----

export const dummyNotices: Notice[] = [...dummyUnivNotices, ...dummyClassNotices];

// ---- 学内共有ファイル（LCAM） ----

export const dummyCommonFiles: CommonFileItem[] = [
  {
    id: '1001',
    category: '教務',
    title: '2026年度 履修登録の手引き',
    downloadCount: 1284,
    size: '3.43 MB',
    updatedAt: '2026/04/01',
  },
  {
    id: '1002',
    category: '学生生活',
    title: '奨学金申請書（様式）',
    downloadCount: 356,
    size: '212 KB',
    updatedAt: '2026/05/12',
  },
  {
    id: '1003',
    category: '就職',
    title: '就職ガイダンス配布資料',
    downloadCount: 98,
    size: '8.10 MB',
    updatedAt: '2026/06/03',
  },
];

export const dummyCommonFileDetail: CommonFileDetail = {
  id: '1001',
  title: '2026年度 履修登録の手引き',
  category: '教務',
  description: '履修登録の流れ、注意事項、締切をまとめた冊子です。',
  publicPeriod: '2026/04/01 ～ 2027/03/31',
  files: [
    { prefix: 'a', no: 1, name: '履修登録の手引き.pdf', size: '3.43 MB' },
    { prefix: 'a', no: 2, name: '履修登録スケジュール.xlsx', size: '41 KB' },
  ],
};

// ---- レポート（LCAM） ----

export const dummyReports: ReportItem[] = [
  {
    id: '2001',
    subject: 'プログラミング演習',
    term: '後期/木1',
    title: '第1回 課題レポート',
    status: '受付中',
    period: '2026/09/23 18:00 ～ 2026/10/07 23:00',
    lastSubmittedAt: '',
    format: 'Web',
    canSubmit: true,
    canCancel: false,
  },
  {
    id: '2002',
    subject: '線形代数',
    term: '後期/火2',
    title: '中間レポート',
    status: '締切',
    period: '2026/09/01 09:00 ～ 2026/09/15 23:00',
    lastSubmittedAt: '2026/09/14 22:25',
    format: 'Web',
    canSubmit: false,
    canCancel: false,
  },
];

export const dummyReportDetail: ReportDetail = {
  id: '2002',
  status: '締切',
  title: '中間レポート',
  period: '2026/09/01 09:00 ～ 2026/09/15 23:00',
  evaluation: '点数（上限 100点）',
  description: '第1回から第4回までの内容について、A4 2枚以内でまとめてください。',
  referenceMaterial: '講義資料を参照',
  notice: '締切後の提出は受け付けません。',
  reminder: '登録されていません。',
  result: [],
  submissions: [
    {
      heading: '1.comment by 学生 2026/09/14 22:25',
      lines: ['提出します。'],
      files: [{ studentCode: 'a1234567', submitNo: 1, fileNo: 1, name: '中間レポート.pdf' }],
    },
  ],
};

// ---- 施設（LCAM） ----

export const dummyFacilities: FacilityItem[] = [
  {
    id: '1001',
    building: '1号館',
    buildingCode: '01',
    name: '1号館 101教室',
    capacity: 120,
    examCapacity: 60,
    equipment: ['プロジェクター', 'マイク'],
  },
  {
    id: '1002',
    building: '1号館',
    buildingCode: '01',
    name: '1号館 102教室',
    capacity: 48,
    examCapacity: 24,
    equipment: ['プロジェクター'],
  },
  {
    id: '2001',
    building: '2号館',
    buildingCode: '02',
    name: '2号館 201演習室',
    capacity: 0,
    examCapacity: 0,
    equipment: [],
  },
];

// 2026-09-21（月）〜09-27（日）の週。
export const dummyFacilitySchedule: FacilityWeek = {
  dates: [
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-09-24',
    '2026-09-25',
    '2026-09-26',
    '2026-09-27',
  ],
  rooms: [
    {
      id: '1001',
      name: '1号館 101教室',
      days: [
        { date: '2026-09-21', events: [] },
        { date: '2026-09-22', events: [] },
        { date: '2026-09-23', events: [] },
        { date: '2026-09-24', events: [] },
        {
          date: '2026-09-25',
          events: [
            { start: '09:00', end: '10:30', title: 'プログラミング演習', teacher: '山田 太郎' },
            { start: '13:00', end: '14:30', title: '線形代数', teacher: '鈴木 花子', note: '補講' },
          ],
        },
        { date: '2026-09-26', events: [] },
        { date: '2026-09-27', events: [] },
      ],
    },
    {
      id: '1002',
      name: '1号館 102教室',
      days: [
        { date: '2026-09-21', events: [] },
        { date: '2026-09-22', events: [] },
        { date: '2026-09-23', events: [] },
        { date: '2026-09-24', events: [] },
        { date: '2026-09-25', events: [{ start: '', end: '', title: '学内行事（終日）' }] },
        { date: '2026-09-26', events: [] },
        { date: '2026-09-27', events: [] },
      ],
    },
  ],
};

// ---- 学事システム（LCAM から引き渡し） ----

// 結合セルは展開済み（同じ値の繰り返し）。先頭 2 行が見出し。
export const dummyCredits: CreditStatus = {
  tabs: ['卒業進級用１年', '卒業進級用２年'],
  headerRows: 2,
  rows: [
    ['区分', '区分', '必要単位', '修得単位', '修得単位'],
    ['区分', '区分', '必要単位', '認定', '修得'],
    ['基礎', '共通', '10', '2', '8'],
    ['基礎', '専門', '20', '0', '14'],
    ['専門', '必修', '12', '0', '6'],
    ['専門', '選択', '8', '0', '4'],
  ],
  note: '総修得単位数 35 単位以上',
};

export const dummyCurriculum: CurriculumItem[] = [
  {
    code: 'A1001',
    name: '線形代数',
    category: '基礎（共通）',
    creditType: '必修',
    credits: 2,
    grade: '優',
  },
  {
    code: 'A1002',
    name: 'プログラミング演習',
    category: '専門（他学科等）',
    creditType: '選択',
    credits: 1,
    grade: '',
  },
  {
    code: 'B2001',
    name: '英語コミュニケーション',
    category: '基礎（共通）',
    creditType: '必修',
    credits: 2,
    grade: '不可',
  },
];

export const dummySchoolEvents: SchoolEvents = {
  nendo: 2026,
  months: [
    {
      month: 9,
      days: [
        { date: '2026-09-21', weekday: '月', holiday: '敬老の日', event: '' },
        { date: '2026-09-22', weekday: '火', holiday: '国民の休日', event: '' },
        { date: '2026-09-23', weekday: '水', holiday: '秋分の日', event: '' },
        { date: '2026-09-25', weekday: '金', holiday: '', event: '後期授業開始' },
        { date: '2026-09-26', weekday: '土', holiday: '', event: '履修登録締切' },
      ],
    },
  ],
};

// ---- 連絡の検索（PC 版） ----

export const dummyPcNoticeList: PcNoticeList = {
  items: [
    {
      kind: 'class',
      id: '1001',
      title: '第 3 回の課題について',
      category: '課題',
      sender: '山田 太郎',
      subject: '線形代数',
      term: '後期/火2',
      important: true,
      startAt: '2026/09/24 11:00',
      endAt: '2026/10/02 00:00',
    },
    {
      kind: 'class',
      id: '1002',
      title: '教室変更のお知らせ',
      category: '教室変更',
      sender: '佐藤 花子',
      subject: 'プログラミング演習',
      term: '後期/木3',
      important: false,
      startAt: '2026/09/22 09:00',
      endAt: '2026/09/30 00:00',
    },
  ],
  categories: ['課題', '教室変更', '休講・補講'],
  subjects: ['線形代数', 'プログラミング演習'],
};

export const dummyPcNoticeDetail: PcNoticeDetail = {
  kind: 'class',
  id: '1001',
  category: '課題',
  title: '第 3 回の課題について',
  body: '第 3 回の課題を LCAM のレポートから提出してください。\n詳細は https://example.com/report を参照。',
  sender: '山田 太郎',
  important: true,
  period: '2026/09/24 11:00 ～ 2026/10/02 00:00',
  referenceUrls: ['https://example.com/report'],
  files: [{ prefix: 'n', no: 1, name: '課題3.pdf', size: '120 KB' }],
  reply: '返信不可',
};

// ---- 抽選履修登録の結果（学事システム） ----

export const dummyLottery: LotteryResult[] = [
  {
    slot: '火Ⅳ',
    subject: '経済学入門',
    classCode: 'E3001',
    biweekly: '',
    category: '基礎（共通）',
    creditType: '選択',
    credits: 2,
    campus: '八草',
    capacity: 60,
    preference: 1,
    result: '当選',
    processedAt: '2026/09/20',
  },
  {
    slot: '火Ⅳ',
    subject: '心理学概論',
    classCode: 'P3002',
    biweekly: '',
    category: '基礎（共通）',
    creditType: '選択',
    credits: 2,
    campus: '八草',
    capacity: 40,
    preference: 2,
    result: '落選',
    processedAt: '2026/09/20',
  },
  {
    slot: '木Ⅲ',
    subject: '哲学',
    classCode: 'H3003',
    biweekly: '隔週',
    category: '基礎（共通）',
    creditType: '選択',
    credits: 1,
    campus: '八草',
    capacity: 50,
    preference: 1,
    result: '',
    processedAt: '',
  },
];

// ---- 教職員スケジュール（LCAM） ----

export const dummyStaff: StaffMember[] = [
  { code: 'S0001', name: '佐藤　花子', kana: 'サトウ　ハナコ', department: '情報学部 情報科学科' },
  { code: 'S0002', name: '佐藤　一郎', kana: 'サトウ　イチロウ', department: '工学部 電気電子工学科' },
];

export const dummyStaffSchedule: { staff: StaffMember; days: ScheduleDay[] } = {
  staff: dummyStaff[0],
  days: [
    {
      date: '2026-09-25',
      events: [
        {
          title: 'コンピュータネットワーク',
          startTime: '2026-09-25T10:40',
          endTime: '2026-09-25T12:10',
          location: '八草 3-102',
          roomId: '3-102',
          period: 2,
        },
      ],
    },
    { date: '2026-09-26', events: [] },
  ],
};
