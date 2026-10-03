// Single gateway from the frontend to the Speed API Worker. The backend address
// comes only from VITE_API_URL, so the frontend can be hosted anywhere.
const TOKEN_KEY = "speed_session";

export const API_URL = (import.meta.env["VITE_API_URL"] as string | undefined)?.replace(/\/$/, "") ?? "";

export const getToken = () => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY));
export function setToken(t: string | null) {
  if (typeof window === "undefined") return;
  if (t) window.localStorage.setItem(TOKEN_KEY, t);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function rpc<T>(name: string, data?: unknown): Promise<T> {
  if (!API_URL) throw new ApiError(0, "Backend address (VITE_API_URL) is not configured");
  const token = getToken();
  const res = await fetch(`${API_URL}/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body.result as T;
}

/** Builds a typed client function with the `fn({ data })` call shape. */
type Handler = (raw?: never) => Promise<unknown>;
export function endpoint<F extends Handler>(name: string) {
  return (arg?: { data?: Parameters<F>[0] extends never ? unknown : unknown }) => rpc<Awaited<ReturnType<F>>>(name, arg?.data);
}

export const oauthStartUrl = (provider: "google" | "github") =>
  `${API_URL}/oauth/${provider}?return=${encodeURIComponent(window.location.origin)}`;
