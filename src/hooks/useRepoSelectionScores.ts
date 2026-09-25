import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { selectionScores } from "@/lib/repoSelectionState";
import { getRepoSelectionStore } from "@/services/repoSelectionStore";

/** Per-account usage scores for repositories picked from the dashboard. */
export function useRepoSelectionScores() {
  const account = useActiveAccount();
  const pubkey = account?.pubkey;
  const store = useMemo(
    () => getRepoSelectionStore(pubkey ?? "anonymous"),
    [pubkey],
  );
  useEffect(() => store.acquire(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const scores = useMemo(() => selectionScores(state, Date.now()), [state]);
  return { scores, recordSelection: store.record };
}
