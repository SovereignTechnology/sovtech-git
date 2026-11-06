import { markFromCache } from "applesauce-core/helpers";
import { from, merge, mergeMap, tap } from "rxjs";
import type { Filter, NostrEvent } from "applesauce-core/helpers";
import "@/lib/localNetworkInstall";
import { optionalLocalCacheRequest, writeLocalCache } from "./localCache";

import { relayEventPresence } from "@/lib/relayEventPresence";
import type { RelayEventPresence } from "@/lib/relayEventPresence";
import { instrumentCacheQuery } from "@/lib/perfRuntime";
import {
  isPrivateRepositoryEvent,
  isPrivateRepositoryEventId,
} from "@/services/privateRepositoryScope";

// No local discovery before login. Injected native/extension providers remain
// untouched; the polyfill supplies durable IndexedDB storage immediately.
export const hasInjectedCache = window.nostrdb !== undefined;
window.nostrdbConfig = { ...window.nostrdbConfig, localRelays: [] };
await import("window.nostrdb.js");

const DELETION_PERSIST_TIMEOUT_MS = 5_000;
const DELETION_PERSIST_POLL_MS = 25;

// Browser extensions and native hosts may still expose the legacy filters API.
function queryDatabase(filters: Filter[]): Promise<NostrEvent[]> {
  const database: {
    query?: (filters: Filter[]) => Promise<NostrEvent[]>;
    filters?: (filters: Filter[]) => Promise<NostrEvent[]>;
  } = window.nostrdb;
  if (typeof database.query === "function") return database.query(filters);
  if (typeof database.filters === "function") return database.filters(filters);
  throw new Error("The Nostr cache provider does not support filter queries");
}

/**
 * Request events from the IndexedDB cache.
 * Used by event loaders to check cache before querying relays.
 * Returns empty array if cache is not available.
 */
async function queryCache(filters: Filter[]): Promise<NostrEvent[]> {
  const stored = await queryDatabase(filters);
  return stored.filter((event) => !isPrivateRepositoryEventId(event.id));
}

/** For loaders that already run cache and network branches in parallel. */
export const parallelCacheRequest = (filters: Filter[]) =>
  merge(
    from(cacheRequest(filters)).pipe(mergeMap((events) => from(events))),
    optionalLocalCacheRequest(filters),
  ).pipe(tap((event) => markFromCache(event)));

export const cacheRequest =
  // Profiling builds only: per-shape timings in `__gwPerf.report()`.
  import.meta.env.VITE_PROFILE === "1"
    ? instrumentCacheQuery(queryCache)
    : queryCache;

// Repository collaboration bodies are written by their repository owner only.
// Identity/configuration caching and verified deletion persistence stay separate.
const repositoryKinds = new Set([
  1111, 1617, 1618, 1619, 1621, 1622, 1624, 1630, 1631, 1632, 1633, 1985, 9841,
  9842, 39842,
]);

/** Save general-purpose events; repository owners admit collaboration events. */
export async function saveEvents(events: NostrEvent[]) {
  const admitted = events.filter(
    (event) =>
      !isPrivateRepositoryEvent(event) && !repositoryKinds.has(event.kind),
  );
  await Promise.allSettled(admitted.map((event) => window.nostrdb.add(event)));
  void writeLocalCache(admitted);
}

/** Scoped to a repository loader's lifetime. Late relay confirmation can make
 * an existing outbox event eligible without another EventStore insertion.
 * Admission does not guarantee continued relay retention. Future disk pruning
 * would need completed absence evidence across the same repository filters;
 * a timeout or a missing response must never evict a cached event.
 */
export function createRepositoryCacheWriter(
  presence: RelayEventPresence = relayEventPresence,
  write: (events: NostrEvent[]) => Promise<unknown> = async (events) => {
    await Promise.all(events.map((event) => window.nostrdb.add(event)));
    void writeLocalCache(events);
  },
) {
  let relays: readonly string[] = [];
  const candidates = new Map<string, NostrEvent>();
  const saved = new Set<string>();
  const pending = new Map<string, NostrEvent>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const events = [...pending.values()].filter(
      (event) =>
        !isPrivateRepositoryEvent(event) && presence.has(event.id, relays),
    );
    pending.clear();
    if (!events.length) return;
    for (const event of events) saved.add(event.id);
    void write(events).catch(() => {
      for (const event of events) saved.delete(event.id);
    });
  };
  const consider = (event: NostrEvent) => {
    // Verified kind-5 events have their own durable writer. Do not persist raw
    // deletion requests here or let discussion traffic evict deletion guards.
    if (closed || event.kind === 5 || isPrivateRepositoryEvent(event)) return;
    candidates.set(event.id, event);
    if (saved.has(event.id) || !presence.has(event.id, relays)) return;
    pending.set(event.id, event);
    timer ??= setTimeout(flush, 250);
  };
  const subscription = presence.changes$.subscribe((ids) => {
    for (const id of ids) {
      const event = candidates.get(id);
      if (event) consider(event);
    }
  });
  return {
    consider,
    setRelays(next: readonly string[]) {
      relays = next;
      for (const event of candidates.values()) consider(event);
    },
    close() {
      flush();
      closed = true;
      subscription.unsubscribe();
      candidates.clear();
    },
  };
}

/** Load durable kind-5 tombstones before any cached originals are consumed. */
export async function loadDeletionEvents(): Promise<NostrEvent[]> {
  return queryDatabase([{ kinds: [5] }]);
}

/** Persist a verified kind-5 event outside EventStore.insert$. */
export async function saveDeletionEvent(event: NostrEvent): Promise<void> {
  if (isPrivateRepositoryEvent(event)) return;
  // Strip Applesauce's symbol metadata and detach nested tag arrays before the
  // asynchronous nostr-idb write queue observes the event.
  const durableEvent: NostrEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };

  await window.nostrdb.add(durableEvent);
  void writeLocalCache([durableEvent]);

  // window.nostrdb.add() acknowledges its in-memory write queue, not the
  // eventual IndexedDB commit. Wait for the public exact-event read to prove
  // durability so an immediate reload cannot race the queued tombstone.
  const deadline = Date.now() + DELETION_PERSIST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await window.nostrdb.event(durableEvent.id)) return;

    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.min(DELETION_PERSIST_POLL_MS, deadline - Date.now()),
      );
    });
  }

  throw new Error(
    `Deletion tombstone ${durableEvent.id} was not durably stored within ${DELETION_PERSIST_TIMEOUT_MS}ms`,
  );
}
