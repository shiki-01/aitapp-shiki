import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAssignmentsWithStatus } from '../src/upstream/moodle/access';

afterEach(() => vi.unstubAllGlobals());

const DAY = 24 * 60 * 60 * 1000;
const sec = (ms: number) => Math.floor(ms / 1000);

// 課題 1: 期限内・提出済 / 2: 期限内・未提出 / 3: 期限切れ・未提出 / 4: 期限切れ・下書き
const courses = {
  courses: [
    {
      id: 10,
      fullname: 'サンプルコース',
      assignments: [
        { id: 1, name: '課題1', intro: '', duedate: sec(Date.now() + DAY), cutoffdate: 0 },
        { id: 2, name: '課題2', intro: '', duedate: sec(Date.now() + 2 * DAY), cutoffdate: 0 },
        { id: 3, name: '課題3', intro: '', duedate: sec(Date.now() - 2 * DAY), cutoffdate: 0 },
        { id: 4, name: '課題4', intro: '', duedate: sec(Date.now() - 3 * DAY), cutoffdate: 0 },
      ],
    },
  ],
};
const statusOf: Record<string, string> = { '1': 'submitted', '2': 'new', '3': 'new', '4': 'draft' };

function stub() {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const p = new URLSearchParams(String(init.body));
    const fn = p.get('wsfunction');
    if (fn === 'mod_assign_get_assignments') return Response.json(courses);
    if (fn === 'mod_assign_get_submission_status') {
      const id = p.get('assignid')!;
      asked.push(id);
      return Response.json({
        lastattempt: {
          submission: { status: statusOf[id], timemodified: sec(Date.now() - 3600_000) },
          gradingstatus: 'notgraded',
        },
      });
    }
    return new Response('unexpected', { status: 500 });
  });
  return asked;
}

describe('getAssignmentsWithStatus: assignmentIds', () => {
  it('既定では期限切れを除く（課題 1・2 だけ）', async () => {
    const asked = stub();
    const r = await getAssignmentsWithStatus('cms.aitech.ac.jp', 'tok');
    expect(r.assignments.map((a) => a.id)).toEqual([1, 2]);
    expect(asked).toEqual(['1', '2']);
  });

  it('assignmentIds を指定すると、期限切れも含めて指定した課題だけの提出状況を返す', async () => {
    const asked = stub();
    const r = await getAssignmentsWithStatus('cms.aitech.ac.jp', 'tok', { assignmentIds: [4, 1] });
    expect(r.statusIncluded).toBe(true);
    // 締切の早い順（課題 4 → 課題 1）。
    expect(r.assignments.map((a) => [a.id, a.submissionStatus, a.submitted])).toEqual([
      [4, 'draft', false],
      [1, 'submitted', true],
    ]);
    expect(asked.sort()).toEqual(['1', '4']);
  });
});

describe('getAssignmentsWithStatus: state（分類）', () => {
  // 5: 受付開始前 / 6: 受付中（cutoff 延長で due 超過でも open）/ 7: cutoff 超過
  const extra = {
    courses: [
      {
        id: 10,
        fullname: 'サンプルコース',
        assignments: [
          ...courses.courses[0].assignments,
          { id: 5, name: '課題5', intro: '', duedate: sec(Date.now() + 9 * DAY), cutoffdate: 0, allowsubmissionsfromdate: sec(Date.now() + 3 * DAY) },
          { id: 6, name: '課題6', intro: '', duedate: sec(Date.now() - DAY), cutoffdate: sec(Date.now() + DAY) },
          { id: 7, name: '課題7', intro: '', duedate: sec(Date.now() - 5 * DAY), cutoffdate: sec(Date.now() - 4 * DAY) },
        ],
      },
    ],
  };
  const st: Record<string, string> = { ...statusOf, '5': 'new', '6': 'new', '7': 'new' };

  function stub2() {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const p = new URLSearchParams(String(init.body));
      const fn = p.get('wsfunction');
      if (fn === 'mod_assign_get_assignments') return Response.json(extra);
      return Response.json({
        lastattempt: { submission: { status: st[p.get('assignid')!], timemodified: 1 }, gradingstatus: 'notgraded' },
      });
    });
  }

  it('state 指定なしでも各課題に分類が付く（既定は締切超過を除く）', async () => {
    stub2();
    const r = await getAssignmentsWithStatus('cms.aitech.ac.jp', 'tok');
    expect(r.assignments.map((a) => [a.id, a.state])).toEqual([
      [6, 'open'],
      [1, 'submitted'],
      [2, 'open'],
      [5, 'upcoming'],
    ]);
  });

  it('state=closed は締切超過の未提出のみ（提出済みは除く）', async () => {
    stub2();
    const r = await getAssignmentsWithStatus('cms.aitech.ac.jp', 'tok', { states: ['closed'] });
    expect(r.assignments.map((a) => a.id).sort()).toEqual([3, 4, 7]);
  });

  it('state=upcoming / submitted', async () => {
    stub2();
    const up = await getAssignmentsWithStatus('cms.aitech.ac.jp', 'tok', { states: ['upcoming'] });
    expect(up.assignments.map((a) => a.id)).toEqual([5]);
    const sub = await getAssignmentsWithStatus('cms.aitech.ac.jp', 'tok', { states: ['submitted'] });
    expect(sub.assignments.map((a) => a.id)).toEqual([1]);
  });
});
