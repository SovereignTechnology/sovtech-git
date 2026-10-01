import {
  isNotificationReadState,
  notificationStateDelta,
  type NotificationReadState,
} from "@/lib/notifications";

/** Frozen user intent. Each action has its own key to avoid cross-window overwrites. */
export interface PendingNotificationChange {
  id: string;
  changedAt: number;
  order: number;
  replace?: boolean;
  before: NotificationReadState;
  after: NotificationReadState;
}

export const pendingNotificationPrefix = (pubkey: string) =>
  `notifications_pending:${pubkey}:`;

export function readPendingNotifications(
  pubkey: string,
): PendingNotificationChange[] {
  const prefix = pendingNotificationPrefix(pubkey);
  const changes: PendingNotificationChange[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const value = JSON.parse(
        localStorage.getItem(key) ?? "null",
      ) as Partial<PendingNotificationChange> | null;
      if (
        value &&
        typeof value.id === "string" &&
        key === prefix + value.id &&
        typeof value.changedAt === "number" &&
        Number.isFinite(value.changedAt) &&
        Number.isSafeInteger(value.order) &&
        (value.replace === undefined || typeof value.replace === "boolean") &&
        isNotificationReadState(value.before) &&
        isNotificationReadState(value.after)
      )
        changes.push(value as PendingNotificationChange);
    } catch {
      /* A corrupt record must not prevent recovery of other actions. */
    }
  }
  return changes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function replayNotificationChanges(
  base: NotificationReadState,
  changes: readonly PendingNotificationChange[],
): NotificationReadState {
  return changes.reduce(
    (state, change) =>
      change.replace
        ? structuredClone(change.after)
        : notificationStateDelta(change.before, change.after)(state),
    base,
  );
}
