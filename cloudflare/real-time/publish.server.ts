import { envStr } from "../functions/context";
// Records an authoritative change in change_log, then pushes it to the user's
// relay hub. If the push fails, clients recover the event via changesSince().
import { d1 } from "@backend/d1";
import type { Entity, EntityMap, SyncEvent } from "./events";

export async function publish<K extends Entity>(userId: string, entity: K, op: "upsert" | "delete", id: string, version: number, data: EntityMap[K] | null) {
  const [row] = await d1<{ seq: number }>(
    "INSERT INTO change_log (user_id, entity, op, entity_id, version, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
    [userId, entity, op, id, version, data ? JSON.stringify(data) : null],
  );
  const event = { seq: row!.seq, entity, op, id, version, data } as SyncEvent;
  const url = envStr("REALTIME_URL");
  const secret = envStr("REALTIME_SECRET");
  if (url && secret) {
    try {
      await fetch(`${url}/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ userId, events: [event] }),
      });
    } catch (e) {
      console.error("realtime publish failed", e);
    }
  }
  return event;
}

export async function changesSince(userId: string, seq: number, limit = 500) {
  const rows = await d1<{ seq: number; entity: Entity; op: "upsert" | "delete"; entity_id: string; version: number; data: string | null }>(
    "SELECT seq, entity, op, entity_id, version, data FROM change_log WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    [userId, seq, limit + 1],
  );
  const truncated = rows.length > limit;
  const events = rows.slice(0, limit).map((r) => ({ seq: r.seq, entity: r.entity, op: r.op, id: r.entity_id, version: r.version, data: r.data ? JSON.parse(r.data) : null }) as SyncEvent);
  return { events, truncated };
}

export async function latestSeq(userId: string) {
  const [r] = await d1<{ s: number | null }>("SELECT MAX(seq) AS s FROM change_log WHERE user_id = ?", [userId]);
  return r?.s ?? 0;
}
