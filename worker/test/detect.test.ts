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
