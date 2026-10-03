import { envStr } from "../functions/context";
// Mints short-lived tokens that let one authenticated user join only their own
// real-time channel. Verified by the relay with the shared REALTIME_SECRET.
const enc = new TextEncoder();
const b64u = (s: string | ArrayBuffer) =>
  (typeof s === "string" ? btoa(s) : btoa(String.fromCharCode(...new Uint8Array(s))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const REALTIME_TOKEN_TTL = 120;

export async function mintRealtimeToken(userId: string) {
  const secret = envStr("REALTIME_SECRET");
  if (!secret) throw new Error("Real-time is not configured");
  const body = b64u(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + REALTIME_TOKEN_TTL }));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64u(await crypto.subtle.sign("HMAC", key, enc.encode(body)))}`;
}
