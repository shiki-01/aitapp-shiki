// シラバス検索（状態を持たない・CSRF 不要・都度 JSESSIONID）。
// 移植元: access_syllabus.dart。

import { UpstreamError } from '../errors';
import { fetchUpstream } from '../fetch';

const SYLLABUS_ORIGIN = 'syllabus.aitech.ac.jp';
const BASE = `https://${SYLLABUS_ORIGIN}`;

// User-Agent が無いとシラバスサーバーは 500 を返すため必須。
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const constHeader: Record<string, string> = {
  'Accept-Language': 'ja',
  Accept: '*/*',
  'User-Agent': USER_AGENT,
};
const secFetchHeader: Record<string, string> = {
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
};
const contentTypeHeader: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
};

/** GET /ext_syllabus/ → Response（set-cookie で JSESSIONID、body で filters）。 */
export async function getSyllabusSession(): Promise<Response> {
  const res = await fetchUpstream(`${BASE}/ext_syllabus/`, {
    headers: { ...constHeader, ...secFetchHeader },
  });
  if (res.status !== 200) {
    throw new UpstreamError(`Syllabus session error: statusCode=${res.status}`);
  }
  return res;
}

export interface SyllabusSearchParams {
  year: string;
  jSessionId: string; // `JSESSIONID=...`
  campus?: number;
  semester?: number;
  week?: number;
  hour?: number;
  searchWord?: string;
  folder?: string;
}

function n(v: number | undefined): string {
  return v === undefined ? '' : String(v);
}

/** POST syllabusSearch.do → 一覧 HTML。 */
export async function getSyllabusListBody(p: SyllabusSearchParams): Promise<string> {
  const headers = {
    Origin: BASE,
    Referer: `${BASE}/ext_syllabus/`,
    Cookie: p.jSessionId,
    ...constHeader,
    ...secFetchHeader,
    ...contentTypeHeader,
  };
  const data: Record<string, string> = {
    syllabusTitleID: p.year,
    indexID: p.folder ?? '',
    subFolderFlag: 'on',
    syllabusCampus: n(p.campus),
    syllabusSemester: n(p.semester),
    syllabusWeek: n(p.week),
    syllabusHour: n(p.hour),
    kamokuName: '',
    editorName: '',
    freeWord: p.searchWord ?? '',
    actionStatus: 'search',
    subFolderFlag2: 'on',
    bottonType: 'search',
  };
  const res = await fetchUpstream(`${BASE}/ext_syllabus/syllabusSearch.do`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(data).toString(),
  });
  if (res.status !== 200) {
    throw new UpstreamError(`Syllabus search error: statusCode=${res.status}`);
  }
  return res.text();
}

/** GET {detailUrl} → 詳細 HTML。 */
export async function getSyllabus(
  detailUrl: string,
  jSessionId: string,
): Promise<string> {
  // 検索結果 onclick の URL には検索時セッションの `;jsessionid=...` が埋め込まれている。
  // これは現在のセッションと不一致になり 500/不正ページになるため除去し、Cookie に依存する。
  const path = detailUrl.replace(/;jsessionid=[^?]*/i, '');
  const headers = {
    Cookie: jSessionId,
    Referer: `${BASE}/ext_syllabus/syllabusSearch.do;${jSessionId}`,
    ...constHeader,
    ...secFetchHeader,
  };
  const res = await fetchUpstream(`${BASE}${path}`, { headers });
  if (res.status !== 200) {
    throw new UpstreamError(`Syllabus detail error: statusCode=${res.status}`);
  }
  return res.text();
}

/** POST syllabusSearch.do;jsessionid=... → 年度変更に伴う filters 再取得 HTML。 */
export async function refreshFiltersSession(
  year: string,
  jSessionId: string,
): Promise<string> {
  // jSessionId は `JSESSIONID=xxx` 形式。値部分を URL に埋める。
  const value = jSessionId.split('=')[1] ?? '';
  const headers = {
    Cookie: jSessionId,
    ...constHeader,
    ...secFetchHeader,
  };
  const data: Record<string, string> = {
    syllabusTitleID: year,
    indexID: '',
    subFolderFlag: 'on',
    syllabusCampus: '',
    syllabusSemester: '',
    syllabusWeek: '',
    syllabusHour: '',
    kamokuName: '',
    editorName: '',
    freeWord: '',
    actionStatus: 'titleID',
    subFolderFlag2: 'on',
    bottonType: 'titleID',
  };
  const res = await fetchUpstream(
    `${BASE}/ext_syllabus/syllabusSearch.do;jsessionid=${value}`,
    {
      method: 'POST',
      headers: { ...headers, ...contentTypeHeader },
      body: new URLSearchParams(data).toString(),
    },
  );
  if (res.status !== 200) {
    throw new UpstreamError(`Syllabus filters error: statusCode=${res.status}`);
  }
  return res.text();
}
