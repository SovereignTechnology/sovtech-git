import type { NotificationReadState } from "@/lib/notifications";

const storageKey = (pubkey: string) => `notifications_timestamps:${pubkey}`;

/** Optional compaction evidence, never a reason to discard an unknown ID. */
export function readNotificationTimestamps(
  pubkey: string,
): Map<string, number> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey(pubkey)) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return new Map();
    return new Map(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          /^[0-9a-f]{64}$/.test(entry[0]) &&
          typeof entry[1] === "number" &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= 0,
      ),
    );
  } catch {
    return new Map();
  }
}

/** Keep only timestamps still needed by either list in this account's state. */
export function retainNotificationTimestamps(
  pubkey: string,
  state: NotificationReadState,
  events: readonly { id: string; created_at: number }[],
): void {
  const retainedIds = new Set([...state.ri, ...state.ai]);
  const timestamps = readNotificationTimestamps(pubkey);
  for (const event of events) {
    if (
      retainedIds.has(event.id) &&
      Number.isSafeInteger(event.created_at) &&
      event.created_at >= 0
    )
      timestamps.set(event.id, event.created_at);
  }
  for (const id of timestamps.keys()) {
    if (!retainedIds.has(id)) timestamps.delete(id);
  }
  try {
    const key = storageKey(pubkey);
    if (timestamps.size === 0) localStorage.removeItem(key);
    else {
      const serialized = JSON.stringify(Object.fromEntries(timestamps));
      if (localStorage.getItem(key) !== serialized)
        localStorage.setItem(key, serialized);
    }
  } catch {
    // Missing or evicted metadata only defers compaction. Notification state
    // and its durable pending actions remain authoritative.
  }
}
