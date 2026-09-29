import type { SyllabusFilters, SyllabusListItem } from '$lib/api';

// シラバス検索の入力・結果。検索 → 詳細 → 戻る で別ルートへ移っても残す（モジュール状態なので画面を跨いで生きる）。
export const syllabusSearch = $state({
  filters: null as SyllabusFilters | null,
  year: '',
  folder: '',
  campus: '',
  semester: '',
  week: '',
  hour: '',
  word: '',
  results: [] as SyllabusListItem[],
  searched: false,
});
