// 上流アクセスで使う例外型。

/** LCAM 上流セッションが失効していると判定したときに投げる。 */
export class LcamExpiredError extends Error {
  constructor(message = 'LCAM session expired') {
    super(message);
    this.name = 'LcamExpiredError';
  }
}

/** 透過再ログインを試みても回復できなかったときに投げる（手動修正前提）。 */
export class AuthFailedError extends Error {
  constructor(message = 'authentication failed') {
    super(message);
    this.name = 'AuthFailedError';
  }
}

/** Moodle token が失効しているときに投げる（token 版の再取得→リトライは withMoodleToken が行う）。 */
export class MoodleTokenError extends Error {
  constructor(message = 'moodle token invalid') {
    super(message);
    this.name = 'MoodleTokenError';
  }
}

/** 上流からの HTTP ステータス異常など、データ取得に失敗したときに投げる。 */
export class UpstreamError extends Error {
  /** 上流（Moodle 等）が返した機械可読なエラーコード。判別できた場合のみ入る。 */
  readonly upstreamCode?: string;
  constructor(message: string, upstreamCode?: string) {
    super(message);
    this.name = 'UpstreamError';
    this.upstreamCode = upstreamCode;
  }
}

/** パース結果が空などデータが見つからないとき。 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** リクエストパラメータが不正なとき（例: 未対応の設問形式への回答）。 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
