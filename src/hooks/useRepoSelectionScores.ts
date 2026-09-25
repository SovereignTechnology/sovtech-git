import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { selectionScores } from "@/lib/repoSelectionState";
import { getRepoSelectionStore } from "@/services/repoSelectionStore";
import {
  acquireNotificationStore,
  releaseNotificationStore,
  type NotificationStoreEntry,
} from "@/services/notificationStore";

/** Private usage scores synced with the notification key in a separate event. */
export function useRepoSelectionScores() {
  const account = useActiveAccount();
  const pubkey = account?.pubkey;
  const store = useMemo(
    () => getRepoSelectionStore(pubkey ?? "anonymous"),
    [pubkey],
  );
  // The notification owner runs selection sync; its retry covers both.
  const owner = useRef<NotificationStoreEntry>();
  useEffect(() => {
    const release = store.acquire();
    owner.current = pubkey ? acquireNotificationStore(pubkey) : undefined;
    return () => {
      release();
      owner.current = undefined;
      if (pubkey) releaseNotificationStore(pubkey);
    };
  }, [pubkey, store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sync = useSyncExternalStore(store.subscribeStatus, store.getStatus);
  const scores = useMemo(() => selectionScores(state, Date.now()), [state]);
  return {
    scores,
    recordSelection: store.record,
    sync,
    retrySync: () => owner.current?.notificationSync?.retry(),
    enableSync: () =>
      owner.current?.notificationSync?.enableRepoSelectionSync(),
  };
}
