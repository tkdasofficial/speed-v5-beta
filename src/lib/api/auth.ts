// Auth client — calls the Speed API Worker. Types come from the backend handlers (type-only import).
import type * as A from "../../../cloudflare/functions/api/auth";
import { ApiError, endpoint, getToken, setToken } from "./index";

const withToken = <F extends (arg?: { data?: unknown }) => Promise<unknown>>(f: F) =>
  (async (arg?: { data?: unknown }) => {
    const r = (await f(arg)) as { token?: string };
    if (r && typeof r === "object" && r.token) setToken(r.token);
    return r;
  }) as F;

export const signUp = withToken(endpoint<typeof A.signUp>("signUp"));
export const signIn = withToken(endpoint<typeof A.signIn>("signIn"));
export const verifyEmail = endpoint<typeof A.verifyEmail>("verifyEmail");
export const resendVerifyCode = endpoint<typeof A.resendVerifyCode>("resendVerifyCode");
export const requestPasswordReset = endpoint<typeof A.requestPasswordReset>("requestPasswordReset");
export const resetPassword = endpoint<typeof A.resetPassword>("resetPassword");
type Me = Awaited<ReturnType<typeof A.getMe>>;
const ME_KEY = "speed_me";
const fetchMe = endpoint<typeof A.getMe>("getMe");
/**
 * Resolves the signed-in user. Only a definitive "not signed in" answer from the
 * server signs the user out; network hiccups or slow backend starts fall back to
 * the last known profile so a stored session is never lost.
 */
export async function getMe(): Promise<Me | null> {
  if (!getToken()) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const me = await fetchMe();
      if (me) localStorage.setItem(ME_KEY, JSON.stringify(me));
      else { setToken(null); localStorage.removeItem(ME_KEY); }
      return me ?? null;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setToken(null); localStorage.removeItem(ME_KEY); return null; }
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  try { return JSON.parse(localStorage.getItem(ME_KEY) ?? "null") as Me | null; } catch { return null; }
}
export const saveProfile = endpoint<typeof A.saveProfile>("saveProfile");
export const signOut = async () => {
  try { return await endpoint<typeof A.signOut>("signOut")(); } finally { setToken(null); localStorage.removeItem(ME_KEY); }
};
export const getGithubConnection = endpoint<typeof A.getGithubConnection>("getGithubConnection");
