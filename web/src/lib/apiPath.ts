import type { ReportQuery, PcNoticeQuery } from './types';

// browser版(fetch)/desktop版(invoke)の両方で使う、クエリ文字列と
// 添付ファイルAPIパスの組み立て。エンコード規則を1箇所にまとめて重複させない。

// T extends object（indexシグネチャ不要）にすることで、SyllabusSearchParams
// のような具体的なinterfaceもそのまま渡せるようにする。
export function qs<T extends object>(params: T): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as [string, string | number | undefined][]) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function fileApiPath(relativePath: string): string {
  const b64 = btoa(relativePath).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `/api/file/${b64}`;
}

// レポート API の絞り込み条件をクエリ用の値へ。未指定の項目は送らず、上流の初期表示（今の年度・学期）に任せる。
export function reportParams(query: ReportQuery = {}): {
  year?: number;
  semester?: number;
  unsubmitted?: 1;
} {
  return {
    year: query.year,
    semester: query.semester,
    unsubmitted: query.unsubmittedOnly ? 1 : undefined,
  };
}

// 連絡検索 API の絞り込み条件をクエリ用の値へ。未指定の項目は送らない（空文字は qs が落とす）。
// from/to は YYYY-MM-DD のまま送る（worker が YYYY/MM/DD へそろえる）。
export function pcNoticeParams(query: PcNoticeQuery = {}): {
  keyword?: string;
  category?: string;
  subject?: string;
  from?: string;
  to?: string;
  unread?: 1;
  todo?: 1;
  attachment?: 1;
  year?: number;
  semester?: number;
} {
  return {
    keyword: query.keyword,
    category: query.category,
    subject: query.subject,
    from: query.from,
    to: query.to,
    unread: query.unreadOnly ? 1 : undefined,
    todo: query.todoOnly ? 1 : undefined,
    attachment: query.attachmentOnly ? 1 : undefined,
    year: query.year,
    semester: query.semester,
  };
}
