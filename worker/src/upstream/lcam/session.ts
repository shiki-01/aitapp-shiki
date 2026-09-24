// LCAM セッション共通ラッパ。
// LCAM は Entra ID の SSO + MFA だが、本家アプリと同じ方式（MIGRATION_NOTES §15）で得た
// アプリ用資格情報（lcamApp。MFA は初回の登録時だけ）があれば、Worker が透過再ログインする。
//   - Cookie が無い: 資格情報でログインしてから op を実行する。
//   - op が失効を検知: 資格情報でログイン（他リクエストが更新済みの Cookie があればそれを採用）→ op を 1 回だけ再試行。
//   - 再ログイン後も失効 / 資格情報が拒否された: 再登録を求める LcamReauthRequiredError。
//   - 資格情報が無い（Cookie 手動登録のみ）: 従来どおり、失効したら LcamReauthRequiredError。
// LCAM は単一セッションのため、再ログインするたびに他の場所（PC 版ブラウザ・公式アプリ）のセッションは切れる。
// そのため定期的な再ログインや keep-alive はしない（ユーザーの操作で必要になった時だけ再ログインする）。
// 並行リクエストの直列化はしない（同時に失効を検知した場合は互いのセッションを奪い合い得る。既知の制限）。

import type { Env, UserState, LcamCookies, LcamAppCredential } from '../../types';
import { readState, writeState } from '../../store/kv';
import { sameLcamCookies } from './cookies';
import {
  LcamExpiredError,
  LcamReauthRequiredError,
  LcamAppCredentialRejectedError,
} from '../errors';
import { appLogin } from './app-login';
import { decryptJson } from '../../crypto/aes';

/**
 * lastOkAt の更新間隔。KV write（無料枠 1000/日）を消費しすぎないよう、成功のたびには書かず間引く。
 * 画面表示用の粗い記録なので 1 時間に 1 回で足りる。
 */
export const LAST_OK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 「使った Cookie が KV 上でまだ同じ」ときだけ state を書き換える。
 * 失効検知・lastOkAt 更新の最中にユーザーが再登録した場合に、新しい Cookie を
 * 古い結果で潰さないための競合ガード（直列化ではなく、last-write-wins の事故防止）。
 */
async function updateIfSameCookies(
  env: Env,
  userId: string,
  used: LcamCookies,
  mutate: (fresh: UserState) => UserState,
): Promise<void> {
  const fresh = await readState(env, userId);
  if (!fresh || !sameLcamCookies(fresh.lcamCookies, used)) return;
  await writeState(env, userId, mutate(fresh));
}

/** 失効を記録し、Cookie を破棄する（以降のリクエストは LCAM へ行かず即エラーになる）。 */
async function markExpired(env: Env, userId: string, used: LcamCookies): Promise<void> {
  await updateIfSameCookies(env, userId, used, (fresh) => ({
    ...fresh,
    lcamCookies: null,
    lcamSession: {
      registeredAt: fresh.lcamSession?.registeredAt ?? 0,
      lastOkAt: fresh.lcamSession?.lastOkAt,
      expiredAt: Date.now(),
    },
  }));
}

/** 成功時刻を間引きつつ記録する（登録時刻が無い旧 state は対象外）。 */
async function touchLastOk(
  env: Env,
  userId: string,
  state: UserState,
  used: LcamCookies,
): Promise<void> {
  const meta = state.lcamSession;
  if (!meta || meta.expiredAt) return;
  const now = Date.now();
  if (meta.lastOkAt !== undefined && now - meta.lastOkAt < LAST_OK_INTERVAL_MS) return;
  await updateIfSameCookies(env, userId, used, (fresh) => ({
    ...fresh,
    lcamSession: { ...(fresh.lcamSession ?? meta), lastOkAt: now },
  }));
}

/**
 * アプリ用資格情報で透過再ログインを行い、Cookie を取得する。
 * 成功時は KV を更新して Cookie を返す。失敗時は lcamApp を null に設定して
 * 再ログインを禁止し、LcamAppCredentialRejectedError を投げる。
 */
async function reloginWithApp(
  env: Env,
  userId: string,
  state: UserState,
): Promise<LcamCookies> {
  if (!state.lcamApp) {
    throw new Error('lcamApp is required to relogin');
  }

  try {
    const cred = await decryptJson<LcamAppCredential>(env.CRED_KEY, state.lcamApp);
    const cookies = await appLogin(cred);

    // 再ログイン成功。KV から最新 state を読み直し、引き継ぐ。
    const fresh = await readState(env, userId);
    if (fresh?.lcamApp) {
      // lcamApp がまだある場合のみ KV を更新（再ログイン中に削除されていない）。
      await writeState(env, userId, {
        ...fresh,
        lcamCookies: cookies,
        lcamSession: {
          registeredAt: fresh.lcamSession?.registeredAt || Date.now(),
          lastOkAt: Date.now(),
        },
      });
    }
    return cookies;
  } catch (e) {
    if (e instanceof LcamAppCredentialRejectedError) {
      // 資格情報が無効。KV を更新して再ログイン禁止状態にする。
      const fresh = await readState(env, userId);
      if (fresh) {
        await writeState(env, userId, {
          ...fresh,
          lcamApp: null,
          lcamCookies: null,
          lcamSession: {
            registeredAt: fresh.lcamSession?.registeredAt ?? 0,
            lastOkAt: fresh.lcamSession?.lastOkAt,
            expiredAt: Date.now(),
          },
        });
      }
      throw new LcamReauthRequiredError('expired');
    }
    // それ以外の例外は握りつぶさず伝播。
    throw e;
  }
}

/**
 * 登録済みの LCAM Cookie で op を実行する。
 * Cookie が無い場合、資格情報（lcamApp）があれば自動再ログイン。
 * 失効を検知した場合、資格情報があれば再ログイン→1 回だけ再試行。
 * op は失効を検知したら LcamExpiredError を投げること。
 */
export async function withLcamSession<T>(
  env: Env,
  userId: string,
  state: UserState,
  op: (cookies: LcamCookies) => Promise<T>,
): Promise<T> {
  let cookies = state.lcamCookies;
  let loggedIn = false; // 本実行でログインしたかどうか。

  // Cookie が無い場合、資格情報で再ログイン。
  if (!cookies) {
    if (!state.lcamApp) {
      throw new LcamReauthRequiredError(state.lcamSession?.expiredAt ? 'expired' : 'not_registered');
    }
    cookies = await reloginWithApp(env, userId, state);
    loggedIn = true;
  }

  // op 実行。
  let result: T;
  try {
    result = await op(cookies);
  } catch (e) {
    if (!(e instanceof LcamExpiredError)) throw e;

    // 失効を検知。

    // 再ログイン直後でも失効なら、自動復旧は諦める（直後の失効は意図的な削除の可能性）。
    if (loggedIn) {
      await markExpired(env, userId, cookies);
      throw new LcamReauthRequiredError('expired');
    }

    // 資格情報がなければ再ログイン不可。
    if (!state.lcamApp) {
      await markExpired(env, userId, cookies);
      throw new LcamReauthRequiredError('expired');
    }

    // 他のリクエストが新しい Cookie に更新していないか確認。
    const fresh = await readState(env, userId);
    let next = cookies;
    if (fresh?.lcamCookies && !sameLcamCookies(fresh.lcamCookies, cookies)) {
      // 新しい Cookie を採用（ログインしない）。
      next = fresh.lcamCookies;
    } else {
      // 再ログイン。
      next = await reloginWithApp(env, userId, fresh ?? state);
    }

    // 1 回だけ再試行。
    try {
      result = await op(next);
    } catch (e2) {
      if (e2 instanceof LcamExpiredError) {
        // 再試行でも失効。諦める。
        await markExpired(env, userId, next);
        throw new LcamReauthRequiredError('expired');
      }
      throw e2;
    }
    cookies = next;
  }

  // 再ログインしなかった場合のみ lastOkAt を更新。
  if (!loggedIn) {
    await touchLastOk(env, userId, state, cookies);
  }
  return result;
}
