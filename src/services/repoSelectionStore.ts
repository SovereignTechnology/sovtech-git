import { bytesToHex } from "@noble/hashes/utils.js";
import {
  emptySelectionState,
  mergeSelectionStates,
  parseRepoSelectionState,
  selectRepository,
  type RepoSelectionState,
} from "@/lib/repoSelectionState";

/**
 * One merged state per account in localStorage. Tabs converge through storage
 * events: every merge that changes state rewrites the cache, and each device
 * contribution carries its own last-click time, so the later write wins.
 */
function createStore(pubkey: string) {
  const prefix = `gitworkshop:repo-selections:v3:${pubkey}:`;
  const cacheKey = `${prefix}cache`;
  const deviceKey = `${prefix}device`;
  const listeners = new Set<() => void>();
  let state = emptySelectionState();
  let sessionDevice: string | undefined;
  /** Once a cache write fails, clicks stay on a session-only device. */
  let sessionOnly = false;

  function read(raw: string | null): RepoSelectionState | undefined {
    if (raw === null) return emptySelectionState();
    try {
      return parseRepoSelectionState(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  /** Returns false when the merged state could not be persisted. */
  function merge(next: RepoSelectionState): boolean {
    const merged = mergeSelectionStates(state, next, Date.now());
    const serialized = JSON.stringify(merged);
    const changed = serialized !== JSON.stringify(state);
    if (changed) state = merged;
    // Compare with storage: next can be a local click or remote state, not
    // just a cache read. Also repair a cache that fell behind memory.
    let persisted = false;
    try {
      const cached = localStorage.getItem(cacheKey);
      // Preserve unreadable data, including schemas from a newer client.
      if (read(cached) !== undefined) {
        if (cached !== serialized) localStorage.setItem(cacheKey, serialized);
        persisted = true;
      }
    } catch {
      /* Keep the in-memory state when storage is unavailable. */
    }
    if (changed) listeners.forEach((listener) => listener());
    return persisted;
  }
  function restore() {
    try {
      const cached = read(localStorage.getItem(cacheKey));
      if (cached) merge(cached);
    } catch {
      /* Retain available session state. */
    }
  }
  restore();

  function onStorage(event: StorageEvent) {
    if (event.storageArea === localStorage && event.key === cacheKey) {
      const cached = read(event.newValue);
      if (cached) merge(cached);
    }
  }
  let consumers = 0;
  function acquire() {
    if (consumers++ === 0) {
      window.addEventListener("storage", onStorage);
      restore();
    }
    return () => {
      if (--consumers === 0) window.removeEventListener("storage", onStorage);
    };
  }
  const randomDevice = () =>
    bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
  /** Stable per browser profile; a session-only ID when storage is absent. */
  function deviceId(): string {
    if (sessionOnly) return (sessionDevice ??= randomDevice());
    try {
      const stored = localStorage.getItem(deviceKey);
      if (stored && /^[0-9a-f]{24}$/.test(stored)) return stored;
      const created = randomDevice();
      localStorage.setItem(deviceKey, created);
      return created;
    } catch {
      return (sessionDevice ??= randomDevice());
    }
  }
  return {
    acquire,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    merge,
    record(coordinate: string) {
      restore();
      const now = Date.now();
      const before = state;
      if (merge(selectRepository(state, deviceId(), coordinate, now))) return;
      // Sibling tabs cannot see an unpersisted click, so they would keep
      // building on the shared device's older contribution and a later click
      // would replace this one. Keep it on a session-only device instead.
      state = before;
      sessionOnly = true;
      merge(selectRepository(state, deviceId(), coordinate, now));
    },
  };
}
const stores = new Map<string, ReturnType<typeof createStore>>();
export function getRepoSelectionStore(pubkey: string) {
  let store = stores.get(pubkey);
  if (!store) {
    store = createStore(pubkey);
    stores.set(pubkey, store);
  }
  return store;
}
