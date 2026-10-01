import type { NotificationReadState } from "@/lib/notifications";

export interface NotificationSnapshot {
  id?: number;
  pubkey: string;
  recordedAt: number;
  source: string;
  eventId?: string;
  /** Signed event timestamp in seconds, shared across browsers. */
  createdAt?: number;
  windowId?: string;
  state: NotificationReadState;
}

export const notificationHistoryWindowId = crypto.randomUUID();
const HISTORY_CHANGE = "notification-history-change";

/** Refresh only after committed journal writes, including those in other windows. */
export function watchNotificationHistory(
  pubkey: string,
  refresh: () => void,
): () => void {
  const local = (event: Event) => {
    if ((event as CustomEvent<string>).detail === pubkey) refresh();
  };
  const remote = (event: StorageEvent) => {
    if (event.key === `notifications_history_change:${pubkey}`) refresh();
  };
  window.addEventListener(HISTORY_CHANGE, local);
  window.addEventListener("storage", remote);
  return () => {
    window.removeEventListener(HISTORY_CHANGE, local);
    window.removeEventListener("storage", remote);
  };
}

// Separate from the replaceable event cache and current localStorage projection.
// No signing keys or encrypted key envelopes are stored in this journal.
function openHistory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gitworkshop-notification-history", 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("snapshots", { keyPath: "id", autoIncrement: true })
        .createIndex("pubkey", "pubkey");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(
        new Error(
          "Notification history database is blocked by another window.",
        ),
      );
  });
}

export async function readNotificationHistory(
  pubkey: string,
): Promise<NotificationSnapshot[]> {
  const db = await openHistory();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("snapshots", "readonly");
      const request = transaction
        .objectStore("snapshots")
        .index("pubkey")
        .getAll(pubkey);
      transaction.oncomplete = () =>
        resolve((request.result as NotificationSnapshot[]).reverse());
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function recordNotificationSnapshot(
  pubkey: string,
  state: NotificationReadState,
  source: string,
  eventId?: string,
  metadata: { createdAt?: number; recordedAt?: number } = {},
): Promise<boolean> {
  // Copy now: database opening is asynchronous and must not move the snapshot.
  const snapshot: NotificationSnapshot = {
    pubkey,
    state: structuredClone(state),
    source,
    eventId,
    recordedAt: metadata.recordedAt ?? Date.now(),
    createdAt: metadata.createdAt,
    windowId: notificationHistoryWindowId,
  };
  try {
    const db = await openHistory();
    let changed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("snapshots", "readwrite");
        const store = transaction.objectStore("snapshots");
        const request = store.index("pubkey").getAll(pubkey);
        request.onsuccess = () => {
          const records = request.result as NotificationSnapshot[];
          const last = eventId
            ? records.find(
                (record) =>
                  record.eventId === eventId &&
                  record.windowId === notificationHistoryWindowId &&
                  record.source === source,
              )
            : records.at(-1);
          if (
            last?.source === source &&
            last.eventId === eventId &&
            JSON.stringify(last.state) === JSON.stringify(snapshot.state)
          )
            return;
          store.add(snapshot);
          changed = true;
          // Retain a rolling, bounded journal independently for each account.
          for (const record of records.slice(
            0,
            Math.max(0, records.length - 99),
          )) {
            if (record.id !== undefined) store.delete(record.id);
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
    if (changed) {
      window.dispatchEvent(new CustomEvent(HISTORY_CHANGE, { detail: pubkey }));
      try {
        localStorage.setItem(
          `notifications_history_change:${pubkey}`,
          crypto.randomUUID(),
        );
      } catch {
        /* Same-window updates still work when shared storage is unavailable. */
      }
    }
    return true;
  } catch (error) {
    console.warn("Notification recovery snapshot could not be saved", error);
    return false;
  }
}
