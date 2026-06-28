// 失効検知（要件 §8）。ステータスコードでなく HTML の DOM パターンで判定する。
// 実ログインページ HTML を未観測のためヒューリスティック（MIGRATION_NOTES §3.5）。
// 過剰検知を避けるため、ログインフォームの確度の高い痕跡がある場合のみ失効とみなす。

import type { HTMLElement } from '../../html/parser';

/**
 * ログインページ（=失効）かどうかを保守的に判定する。
 * SP ログインフォームには userID と password の入力欄があるため、両方の痕跡が
 * あるときのみ失効とみなす。通常データページには現れない。
 */
export function looksLikeLoginPage(html: string): boolean {
  const lower = html.toLowerCase();
  const hasUserId =
    lower.includes('name="userid"') || lower.includes("name='userid'");
  const hasPassword =
    lower.includes('name="password"') || lower.includes("name='password'");
  const hasLoginAction =
    lower.includes('smartphonelogin') ||
    lower.includes('/login/login/') ||
    lower.includes('prelogin');
  return hasUserId && hasPassword && hasLoginAction;
}

/** isLogin の逆。ログインフォームの error 表示で失敗判定（loginLcam 応答用）。 */
export function isLoginSuccess(root: HTMLElement): boolean {
  // lcam_parse.dart isLogin: #_errorInformation > ul > li:nth-child(1) が空なら成功。
  return (
    root.querySelectorAll('#_errorInformation > ul > li:nth-child(1)').length === 0
  );
}
