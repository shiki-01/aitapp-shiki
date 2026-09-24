// 失効検知（要件 §8）。ステータスコードでなく HTML の DOM パターン / リダイレクト先で判定する。
// LCAM は 2026-09 から Entra ID(SAML SSO + MFA) に移行しており、セッション失効時は
// SSO（/mellon/login → Entra）へ 303 で誘導される。旧来のログインフォーム HTML の検知も残す。
// 過剰検知を避けるため、確度の高い痕跡がある場合のみ失効とみなす（MIGRATION_NOTES §3.5 / §14）。

/** Entra ID（Microsoft ログイン）のホスト。LCAM から誘導される SSO 先。 */
const IDP_HOSTS = [
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net',
  'sts.windows.net',
];

/**
 * 3xx の Location が SSO ログインへの誘導かどうか。
 * LCAM 側は Apache mod_auth_mellon（/mellon/...）と、SSO 開始用の
 * `login/login/initLogin/sso` / `smartPhoneLogin/sso` を使う。
 * Location は絶対 URL・相対 URL のどちらもあり得る。
 */
export function isSsoRedirect(location: string): boolean {
  const lower = location.toLowerCase();
  if (lower.includes('/mellon/')) return true;
  if (lower.includes('login/login/') && /\/sso([?;#]|$)/.test(lower)) return true;
  try {
    const host = new URL(location, 'https://lcam.aitech.ac.jp/').hostname.toLowerCase();
    return IDP_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/**
 * ログインページ（=失効）かどうかを保守的に判定する。
 * (1) 旧来のログインフォーム: userID と password の入力欄＋ログインアクションの痕跡が揃うとき。
 * (2) 未ログインスタブ（実測済み）・SSO 誘導ページ: mellon / Entra への遷移先を含むとき（通常のデータページには現れない）。
 */
export function looksLikeLoginPage(html: string): boolean {
  // 無効なセッションで SP のデータページを開くと、SSO へのリダイレクトではなく
  // 200 のスタブ（実測 2026-09-24: 「ログインされていないためシステムを利用できません」）が返る。
  if (html.includes('ログインされていないため')) return true;
  const lower = html.toLowerCase();
  if (lower.includes('/mellon/login') || lower.includes('login.microsoftonline.com')) {
    return true;
  }
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
