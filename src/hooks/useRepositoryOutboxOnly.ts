import { useCallback, useSyncExternalStore } from "react";
import { useOptionalRepoContext } from "@/pages/repo/RepoContext";
import { relayEventPresence } from "@/lib/relayEventPresence";

/** Unknown or failed relay checks never establish repository exclusion. */
export function useRepositoryOutboxOnly(
  eventId: string | undefined,
  enabled = true,
) {
  const repo = useOptionalRepoContext()?.resolved?.repo;
  const active = enabled && !!eventId && !!repo && !repo.isPrivate;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!active || !eventId) return () => {};
      const sub = relayEventPresence.changes$.subscribe((ids) => {
        if (ids.has(eventId)) notify();
      });
      return () => sub.unsubscribe();
    },
    [active, eventId],
  );
  const snapshot = useCallback(() => {
    if (
      !active ||
      !eventId ||
      relayEventPresence.has(eventId, repo?.relays ?? [])
    )
      return false;
    // Other-relay receipt is not proof of absence from repository relays.
    return (
      relayEventPresence.isAbsent(eventId, repo?.relays ?? []) &&
      relayEventPresence.hasAny(eventId)
    );
  }, [active, eventId, repo?.relays]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
