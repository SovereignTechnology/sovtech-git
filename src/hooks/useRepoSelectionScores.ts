import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  parseSelectionScores,
  recordSelection as applySelection,
} from "@/lib/repoSelectionScore";

// Raw values are cached so snapshots stay referentially stable, and so scores
// survive in memory for the session when localStorage is unavailable.
const snapshots = new Map<string, string | null>();
const listeners = new Set<() => void>();
let listening = false;
const notify = () => {
  listeners.forEach((listener) => listener());
};
function onStorage(event: StorageEvent) {
  if (event.key === null) snapshots.clear();
  else snapshots.delete(event.key);
  notify();
}
function subscribe(listener: () => void) {
  if (!listening) {
    window.addEventListener("storage", onStorage);
    listening = true;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function read(key: string): string | null {
  if (snapshots.has(key)) return snapshots.get(key)!;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    /* Storage unavailable — start empty. */
  }
  snapshots.set(key, raw);
  return raw;
}

/** Local only; per-account decaying scores for repos picked from the dashboard. */
export function useRepoSelectionScores() {
  const account = useActiveAccount();
  const key = `gitworkshop:repo-selections:v1:${account?.pubkey ?? "anonymous"}`;
  const raw = useSyncExternalStore(subscribe, () => read(key));
  const scores = useMemo(() => parseSelectionScores(raw), [raw]);
  const recordSelection = useCallback(
    (coordinate: string) => {
      const current = parseSelectionScores(read(key));
      const next = JSON.stringify(
        applySelection(current, coordinate, Date.now()),
      );
      try {
        localStorage.setItem(key, next);
      } catch {
        /* Keep the in-memory value when storage is unavailable. */
      }
      snapshots.set(key, next);
      notify();
    },
    [key],
  );
  return { scores, recordSelection };
}
