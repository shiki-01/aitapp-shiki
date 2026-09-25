// Moodle 課題の提出状況の共有ストア（メモリのみ）。課題一覧（Assignments）とホームで共有する。
// 提出状況は課題 1 件ごとの問い合わせなので、Worker の subrequest 上限に合わせて 15 件ずつ取り、
// 表示に必要な分だけ取得する。取得済みは TTL 内なら取り直さない。

import { api, type AssignmentSubmission } from '$lib/api';

const BATCH = 15;
const TTL_MS = 5 * 60 * 1000;

class SubmissionStore {
  private map = $state(new Map<number, AssignmentSubmission>());
  private fetchedAt = new Map<number, number>();
  private running = false;
  private queue: number[] = [];
  failed = $state(false);

  get(id: number): AssignmentSubmission | undefined {
    return this.map.get(id);
  }

  /** 提出済みか。未取得は undefined。 */
  submitted(id: number): boolean | undefined {
    const s = this.map.get(id);
    return s ? (s.submitted ?? undefined) : undefined;
  }

  /** ids（優先順）のうち未取得・期限切れのものを取得する。実行中なら待ち行列に足す。 */
  async ensure(ids: number[]): Promise<void> {
    const now = Date.now();
    const want = ids.filter(
      (id) => now - (this.fetchedAt.get(id) ?? 0) > TTL_MS && !this.queue.includes(id),
    );
    if (want.length === 0) return;
    this.queue.push(...want);
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH);
        try {
          const res = await api.assignmentStatuses(batch);
          const next = new Map(this.map);
          const at = Date.now();
          for (const a of res.assignments) {
            next.set(a.id, a);
            this.fetchedAt.set(a.id, at);
          }
          // 応答に無い課題（削除など）は再取得を繰り返さないよう記録だけ残す。
          for (const id of batch) if (!this.fetchedAt.has(id)) this.fetchedAt.set(id, at);
          this.map = next;
          this.failed = false;
        } catch {
          this.failed = true;
          this.queue = []; // 続けても同じ理由で失敗する。次の表示で取り直す。
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export const submissions = new SubmissionStore();
