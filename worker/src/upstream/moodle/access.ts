// Moodle（token 方式・JSON）。移植元: access_moodle.dart。
// 透過再ログインのラップ対象外。token 失効時のみ password で再取得する。

import { UpstreamError } from '../errors';

const MOODLE_ORIGIN = 'cms.aitech.ac.jp';
const WEBSERVICE = '/webservice/rest/server.php';
const BASE = `https://${MOODLE_ORIGIN}`;

const baseHeaders: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
};

/** token が失効しているときに投げる（router が token 再取得→リトライ）。 */
export class MoodleTokenError extends Error {
  constructor(message = 'moodle token invalid') {
    super(message);
    this.name = 'MoodleTokenError';
  }
}

export interface MoodleAssignment {
  id: number;
  name: string;
  description: string;
  dueDate: string; // ISO
  dueEpochMs: number;
  courseId: number;
  courseName: string;
}

/** token 取得。POST /login/token.php。 */
export async function getMoodleToken(
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${BASE}/login/token.php`, {
    method: 'POST',
    headers: baseHeaders,
    body: new URLSearchParams({
      username,
      password,
      service: 'moodle_mobile_app',
    }).toString(),
  });
  if (res.status !== 200) {
    throw new UpstreamError(`Moodle token error: statusCode=${res.status}`);
  }
  const data = (await res.json()) as { token?: string; error?: string };
  if (data.error) {
    throw new UpstreamError(`Moodle token error: ${data.error}`);
  }
  if (!data.token) {
    throw new UpstreamError('Moodle token error: token missing');
  }
  return data.token;
}

interface MoodleAssignmentRaw {
  id: number;
  name: string;
  intro: string;
  duedate: number;
}
interface MoodleCourseRaw {
  id: number;
  fullname: string;
  assignments: MoodleAssignmentRaw[];
}

/** 課題一覧。POST webservice mod_assign_get_assignments。 */
export async function getMoodleAssignments(
  token: string,
): Promise<MoodleAssignment[]> {
  const res = await fetch(`${BASE}${WEBSERVICE}`, {
    method: 'POST',
    headers: baseHeaders,
    body: new URLSearchParams({
      wstoken: token,
      wsfunction: 'mod_assign_get_assignments',
      moodlewsrestformat: 'json',
    }).toString(),
  });
  if (res.status !== 200) {
    throw new UpstreamError(`Moodle assignments error: statusCode=${res.status}`);
  }
  const data = (await res.json()) as {
    courses?: MoodleCourseRaw[];
    exception?: string;
    errorcode?: string;
    message?: string;
  };
  if (data.exception) {
    // token 失効のみ再取得対象。Moodle 標準の errorcode を前提（要確認）。
    if (data.errorcode === 'invalidtoken') {
      throw new MoodleTokenError(data.message ?? data.errorcode);
    }
    throw new UpstreamError(`Moodle assignments error: ${data.message ?? data.exception}`);
  }

  const out: MoodleAssignment[] = [];
  for (const course of data.courses ?? []) {
    for (const a of course.assignments ?? []) {
      const epochMs = a.duedate * 1000;
      out.push({
        id: a.id,
        name: a.name,
        description: a.intro,
        dueDate: new Date(epochMs).toISOString(),
        dueEpochMs: epochMs,
        courseId: course.id,
        courseName: course.fullname,
      });
    }
  }
  return out;
}
