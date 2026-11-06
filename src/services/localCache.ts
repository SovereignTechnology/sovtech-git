import {
  catchError,
  concatWith,
  defer,
  EMPTY,
  filter,
  finalize,
  firstValueFrom,
  Observable,
  ReplaySubject,
  share,
  Subject,
  takeUntil,
  tap,
  throwError,
  timer,
  toArray,
} from "rxjs";
import { markFromCache } from "applesauce-core/helpers";
import {
  isPrivateRepositoryEvent,
  isPrivateRepositoryEventId,
} from "./privateRepositoryScope";
import { onlyEvents, RelayPool } from "applesauce-relay";
import type { Filter, NostrEvent } from "nostr-tools";
import { resilientRequest } from "@/lib/resilientSubscription";
import {
  assertLocalNetworkAccess,
  localNetworkReady,
  networkPermission,
  subscribeLocalNetwork,
} from "@/lib/localNetwork";

export const LOCAL_CACHE_ORIGIN = "http://localhost:4869";
const RELAY = "ws://localhost:4869/";
const PREFERENCE_KEY = "local-cache-choice-v1";
// Separate unsigned cache transport: never attach the account pool's AUTH signer.
const pool = new RelayPool();
let active = false;
let memoryChoice: boolean | undefined;
let generation = 0;
let discovery: AbortController | undefined;
let retryAfter = 0;
const stopped = new Subject<void>();
const inFlight = new Map<string, Observable<NostrEvent>>();

const choiceListeners = new Set<() => void>();
export const subscribeLocalCacheChoice = (listener: () => void) => {
  choiceListeners.add(listener);
  return () => {
    choiceListeners.delete(listener);
  };
};
const choiceChanged = () => choiceListeners.forEach((listener) => listener());
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === PREFERENCE_KEY || event.key === null) {
      memoryChoice = undefined;
      choiceChanged();
    }
  });
}

export function localCacheChoice(): boolean | undefined {
  if (memoryChoice !== undefined) return memoryChoice;
  try {
    const saved = localStorage.getItem(PREFERENCE_KEY);
    return saved === null ? undefined : saved === "true";
  } catch {
    return undefined;
  }
}

export function rememberLocalCacheChoice(enabled: boolean) {
  try {
    localStorage.setItem(PREFERENCE_KEY, String(enabled));
  } catch {
    memoryChoice = enabled;
    // The choice still applies to this session when browser storage is disabled.
  }
  choiceChanged();
}

/** Login owns discovery. Browser storage remains the durable cache throughout;
 * local relay reads supplement it, so enabling never requires a page reload. */
export async function startLocalCache(): Promise<boolean | undefined> {
  discovery?.abort();
  const controller = new AbortController();
  discovery = controller;
  const current = ++generation;
  await localNetworkReady();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    const permission = networkPermission("loopback");
    // Human decision time is not server latency. Older browsers without a
    // permission query get a generous bound; logout/disable always cancels.
    if (permission !== "prompt" && deadline === undefined) {
      deadline = setTimeout(
        () => controller.abort(),
        permission === "unknown" ? 30_000 : 10_000,
      );
    }
  };
  const unwatch = subscribeLocalNetwork(armDeadline);
  try {
    controller.signal.throwIfAborted();
    assertLocalNetworkAccess(LOCAL_CACHE_ORIGIN);
    armDeadline();
    const response = await fetch(LOCAL_CACHE_ORIGIN, {
      headers: { Accept: "application/nostr+json" },
      signal: controller.signal,
    });
    if (current !== generation) return;
    active = response.ok;
    retryAfter = 0;
    return active;
  } catch {
    if (current !== generation) return;
    active = false;
    return false;
  } finally {
    unwatch();
    if (deadline !== undefined) clearTimeout(deadline);
    if (discovery === controller) discovery = undefined;
  }
}

export function stopLocalCache() {
  generation++;
  active = false;
  discovery?.abort();
  stopped.next();
  pool.close();
}

/** Independent, cancellable network source. Disk reads never await this stream.
 * Identical concurrent requests share traffic, but do not retain another cache. */
export function localCacheRequest(filters: Filter[]): Observable<NostrEvent> {
  return defer(() => {
    if (!active || Date.now() < retryAfter) return EMPTY;
    try {
      assertLocalNetworkAccess(LOCAL_CACHE_ORIGIN);
    } catch {
      return EMPTY;
    }
    const key = JSON.stringify(filters);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const current = generation;
    let completed = false;
    const request = resilientRequest(pool, [RELAY], filters, {
      retryCount: 0,
      settle: false,
      onRelayEose: () => {
        completed = true;
      },
    }).pipe(
      onlyEvents(),
      takeUntil(timer(10_000)),
      concatWith(
        defer(() =>
          completed
            ? EMPTY
            : throwError(() => new Error("Local cache read incomplete")),
        ),
      ),
      takeUntil(stopped),
      filter(
        (event) =>
          current === generation &&
          !isPrivateRepositoryEvent(event) &&
          !isPrivateRepositoryEventId(event.id),
      ),
      tap((event) => markFromCache(event)),
      finalize(() => inFlight.delete(key)),
      share({ connector: () => new ReplaySubject<NostrEvent>() }),
    );
    inFlight.set(key, request);
    return request;
  });
}

/** Optional event streams isolate failure from disk and ordinary relay traffic. */
export const optionalLocalCacheRequest = (filters: Filter[]) =>
  localCacheRequest(filters).pipe(
    catchError(() => {
      retryAfter = Date.now() + 30_000;
      return EMPTY;
    }),
  );

/** Coherent repository restores must discard a timed-out partial batch. */
export const queryLocalCache = (filters: Filter[]) =>
  firstValueFrom(localCacheRequest(filters).pipe(toArray()));

/** Best-effort replication of events already admitted to the durable cache.
 * Never delay an IndexedDB write or publish private repository events here. */
export async function writeLocalCache(events: NostrEvent[]) {
  if (!active || !events.length) return;
  const current = generation;
  try {
    assertLocalNetworkAccess(LOCAL_CACHE_ORIGIN);
    if (!active || current !== generation) return;
    await Promise.allSettled(
      events.map((event) => pool.publish([RELAY], event)),
    );
  } catch {
    // Offline local cache must not prevent ordinary use or durable writes.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === PREFERENCE_KEY && event.newValue !== "true")
      stopLocalCache();
  });
}
