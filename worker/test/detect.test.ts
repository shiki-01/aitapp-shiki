import { describe, it, expect } from 'vitest';
import { looksLikeLoginPage } from '../src/upstream/lcam/detect';

describe('looksLikeLoginPage（失効検知）', () => {
  it('userID+password+ログインアクションを備えた HTML はログインページと判定', () => {
    const html = `
      <form action="/login/login/smartphoneLogin">
        <input name="userID" type="text" />
        <input name="password" type="password" />
      </form>`;
    expect(looksLikeLoginPage(html)).toBe(true);
  });

  it('通常のデータページはログインページと判定しない', () => {
    const html = `
      <table id="schedule">
        <tr><td>月1</td><td>データ構造</td></tr>
      </table>`;
    expect(looksLikeLoginPage(html)).toBe(false);
  });

  it('password 欄はあるがログインアクションの痕跡が無ければ失効扱いしない（過剰検知回避）', () => {
    const html = `
      <form action="/settings/change">
        <input name="userID" />
        <input name="password" type="password" />
      </form>`;
    expect(looksLikeLoginPage(html)).toBe(false);
  });
});

import { isSsoRedirect } from '../src/upstream/lcam/detect';

describe('looksLikeLoginPage（SSO 誘導）', () => {
  it('無効セッションで返る未ログインスタブ（実測）は失効と判定', () => {
    const html =
      '<body id="login">総合ポータルシステム<br><li>ログインされていないためシステムを利用できません。<br>ログインしてシステムを利用してください。</li></body>';
    expect(looksLikeLoginPage(html)).toBe(true);
  });

  it('mellon / Entra への遷移を含む HTML は失効と判定', () => {
    expect(looksLikeLoginPage('<a href="/mellon/login?ReturnTo=x">go</a>')).toBe(true);
    expect(looksLikeLoginPage('<form action="https://login.microsoftonline.com/x/saml2">')).toBe(true);
  });
});

describe('isSsoRedirect（3xx の Location による失効検知）', () => {
  it('LCAM の mellon（相対・絶対）と Entra を SSO 誘導と判定', () => {
    expect(
      isSsoRedirect('/mellon/login?ReturnTo=x&IdP=https://sts.windows.net/1dd4d0da/'),
    ).toBe(true);
    // 実測した initLogin/sso の Location（絶対 URL）。
    expect(
      isSsoRedirect(
        'https://lcam.aitech.ac.jp/mellon/login?ReturnTo=https%3A%2F%2Flcam.aitech.ac.jp%2Fportalv2%2Flogin%2Flogin%2FinitLogin%2Fsso&IdP=https%3A%2F%2Fsts.windows.net%2F1dd4d0da%2D8011%2D41fc%2D889e%2Dd7ee3fec9eb6%2F',
      ),
    ).toBe(true);
    expect(isSsoRedirect('https://lcam.aitech.ac.jp/mellon/login?x=1')).toBe(true);
    expect(isSsoRedirect('https://login.microsoftonline.com/tenant/saml2?SAMLRequest=x')).toBe(true);
  });

  it('SSO 開始エンドポイント（initLogin/sso, smartPhoneLogin/sso）を SSO 誘導と判定', () => {
    expect(isSsoRedirect('/portalv2/login/login/initLogin/sso')).toBe(true);
    expect(isSsoRedirect('/portalv2/login/login/smartPhoneLogin/sso;jsessionid=abc')).toBe(true);
  });

  it('通常の同一オリジンのリダイレクトは SSO 誘導ではない', () => {
    expect(isSsoRedirect('/portalv2/smartphone/smartPhoneHome/nextPage/timeTable')).toBe(false);
    expect(isSsoRedirect('https://lcam.aitech.ac.jp/portalv2/')).toBe(false);
  });
});
