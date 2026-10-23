/**
 * Batched tag history with a persistent resilient live subscription.
 * Automatic mode uses v7 finite-window coverage, including relay caps below
 * the requested page size. Only successful coverage is cached as exhausted;
 * cancellation, failed requests and saturated timestamps stay incomplete.
 * Manual mode uses explicit batches over v7 point windows. UI settlement is not evidence of historical completeness.
 */

import { filterDuplicateEvents, mapEventsToStore } from "applesauce-core";
import { mergeRelaySets } from "applesauce-core/helpers/relays";
import type { Filter } from "applesauce-core/helpers";
import type { EventStore } from "applesauce-core";
import { batchHistory } from "./batchHistory";
import { historyWindow } from "./historyWindow";
import type { TimelineStatus } from "applesauce-loaders/loaders";
import type { TagValuePointer } from "applesauce-loaders/loaders";
import type { CacheRequest, TimelessFilter } from "applesauce-loaders";
import { makeCacheRequest } from "applesauce-loaders/helpers";
import type { RelayPool } from "applesauce-relay";
import { onlyEvents } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import {
  EMPTY,
  Observable,
  Subject,
  bufferTime,
  filter,
  merge,
  map,
  share,
  switchMap,
  take,
} from "rxjs";
import { makeSettleSignal, DEFAULT_SETTLE_TIME } from "./settleSignal";
import type { SettleSignal, SettleSignalOptions } from "./settleSignal";
import {
  resilientHistoryRequest,
  isHistoryTerminalError,
  HistoryAdmissionError,
  resilientSubscription,
} from "./resilientSubscription";

export type { TagValuePointer };

/** Response type — mirrors applesauce's SubscriptionResponse pattern */
export type PaginatedTagValueResponse = NostrEvent | "EOSE";

export type PaginatedTagValueLoaderOptions = {
  /** Time window to batch incoming pointers in ms (default 1000) */
  bufferTime?: number;
  /** Max pointers per batch window (default 200) */
  bufferSize?: number;
  /** Restrict to specific kinds */
  kinds?: number[];
  /** Number of events to request per block — also the pagination threshold (default 500) */
  limit?: number;
  /** Historical coverage is separate from the UI EOSE settle signal. */
  onHistoryStatus?: (status: TimelineStatus) => void;
  /** EventStore for deduplication and storage */
  eventStore?: EventStore;
  /** Extra relays to always include */
  extraRelays?: string[];
  /** Method used to load from the cache */
  cacheRequest?: CacheRequest;
  /**
   * Debounce window in ms before emitting "EOSE" after the first relay
   * finishes its current work (default 200).
   */
  settleTime?: number;
  /**
   * If provided, disables automatic backward pagination. Each emission
   * requests the next block from all non-exhausted relays. Use for
   * "load more" button patterns.
   */
  manualPaginate$?: Observable<void>;
  /**
   * Number of reconnect attempts per relay before giving up (before first
   * EOSE). After first EOSE retries are unlimited. Default: 3.
   */
  retryCount?: number;
  /**
   * Gap-fill overlap buffer in seconds. Default: 600 (10 minutes).
   */
  gapFillBuffer?: number;
};

export type PaginatedTagValueLoader = (
  pointer: TagValuePointer,
) => Observable<PaginatedTagValueResponse>;

/**
 * Build a per-relay filter map from a batch of pointers.
 * Returns Record<relayUrl, Filter> with all tag values merged per relay.
 */
function buildRelayFilterMap(
  tagName: string,
  pointers: TagValuePointer[],
  opts: PaginatedTagValueLoaderOptions,
): Record<string, Filter> {
  const filterTag = `#${tagName}` as keyof Filter;

  return pointers.reduce<Record<string, Filter>>((map, pointer) => {
    const relays = mergeRelaySets(pointer.relays, opts.extraRelays);
    for (const relay of relays) {
      if (!map[relay]) {
        const f: Filter = { [filterTag]: [pointer.value] };
        if (opts.kinds) f.kinds = opts.kinds;
        if (opts.limit) f.limit = opts.limit;
        map[relay] = f;
      } else {
        (map[relay][filterTag] as string[]).push(pointer.value);
      }
    }
    return map;
  }, {});
}

/**
 * Derive a stable exhaustion key for a relay + filter combination.
 * Sorts tag values so order doesn't matter.
 */
function exhaustionKey(relay: string, tagName: string, f: Filter): string {
  const filterTag = `#${tagName}`;
  const values = ((f[filterTag as keyof Filter] as string[]) ?? [])
    .slice()
    .sort()
    .join(",");
  const kinds = (f.kinds ?? []).slice().sort().join(",");
  return `${relay}::${kinds}::${values}`;
}

/**
 * Process one relay stream: open a resilient live subscription and (if needed)
 * paginate backward until exhausted.
 *
 * Reconnect behaviour mirrors processRelay in resilientSubscription:
 *   - Exponential backoff, rate-limit handling, permanent error fast-fail,
 *     AuthRequired fast-fail, unlimited retries after first EOSE.
 *
 * @param signal          - settle signal; call extend/settle/error as relay
 *                          work progresses.
 * @param manualPaginate$ - if provided, disables auto-pagination; each emission
 *                         requests the next backward block from this relay.
 */
function processRelayStream(
  pool: RelayPool,
  relay: string,
  relayFilter: Filter,
  paginationFilter: TimelessFilter,
  key: string,
  limit: number,
  retryCount: number,
  gapFillBuffer: number,
  exhausted: Set<string>,
  signal: SettleSignal,
  manualPaginate$: Observable<void> | undefined,
  onHistoryStatus: ((status: TimelineStatus) => void) | undefined,
): Observable<NostrEvent> {
  // No limit on the live filter — we want all future events.
  const liveFilter: Filter = { ...relayFilter };
  delete liveFilter.limit;

  // If already exhausted, just open the live subscription — signal settled
  // immediately since there is no history work to do.
  if (exhausted.has(key)) {
    signal.settle(relay);
    return resilientSubscription(pool, [relay], [liveFilter], {
      paginate: false,
      gapFill: true,
      settle: false,
      retryCount,
      gapFillBuffer,
    }).pipe(onlyEvents()) as Observable<NostrEvent>;
  }

  return new Observable<NostrEvent>((subscriber) => {
    let oldestSeen: number | undefined;
    let eoseSeen = false;
    let liveEnded = false;
    let historyDone = false;
    let paginateSub: { unsubscribe(): void } | undefined;

    const startPagination = () => {
      if (!manualPaginate$) {
        // This path starts only after a real EOSE for the untimed live filter.
        // Zero events proves an empty snapshot; a non-empty short response may
        // still be capped by the relay and must go through history coverage.
        if (oldestSeen === undefined) {
          const window = { since: 0, until: Math.floor(Date.now() / 1000) };
          historyDone = true;
          exhausted.add(key);
          signal.settle(relay);
          onHistoryStatus?.({
            source: relay,
            filter: paginationFilter,
            window,
            buffer: window,
            state: "covered",
          });
          return;
        }
        paginateSub = historyWindow(
          (_relays, filters) => {
            signal.extend(relay);
            return resilientHistoryRequest(pool, relay, filters);
          },
          relay,
          [paginationFilter],
          {
            limit,
            until: oldestSeen,
            isTerminalError: isHistoryTerminalError,
            onStatus: (status) => {
              onHistoryStatus?.(status);
              if (status.state === "incomplete") {
                if (status.error instanceof HistoryAdmissionError)
                  signal.settle(relay);
                else signal.error(relay);
              }
            },
            onComplete: (covered) => {
              // Cancellation, failures and boundary saturation are not exhaustion.
              if (covered) {
                exhausted.add(key);
                signal.settle(relay);
              }
            },
          },
        ).subscribe({
          next: (event) => subscriber.next(event),
          complete: () => {
            historyDone = true;
            if (liveEnded) subscriber.complete();
          },
        });
        return;
      }
      if (paginateSub) return;
      paginateSub = manualPaginate$
        .pipe(
          map(() => ({ limit, until: oldestSeen })),
          batchHistory(
            (_relays, filters) => {
              signal.extend(relay);
              return resilientHistoryRequest(pool, relay, filters);
            },
            relay,
            [paginationFilter],
            {
              onStatus: onHistoryStatus,
              retryCount,
              isTerminalError: isHistoryTerminalError,
              isAdmissionError: (error) =>
                error instanceof HistoryAdmissionError,
              onBatchComplete: (result) => {
                if (result.exhausted) exhausted.add(key);
                if (result.incomplete) signal.error(relay);
                else signal.settle(relay);
              },
            },
          ),
        )
        .subscribe({ next: (event) => subscriber.next(event) });
    };

    if (manualPaginate$) startPagination();

    // Delegate reconnect, backoff, rate-limit handling, and foreground gap-fill
    // to resilientSubscription. settle: false — we manage the outer signal
    // ourselves via onRelaySettle/onRelayError callbacks, which resilientSubscription
    // fires at every point it would normally call signal.settle/error. This
    // restores the rate-limit cooldown settle that was lost when buildResilientLiveSub
    // was replaced: if the relay is rate-limited on first connect, onRelaySettle
    // fires immediately so the EOSE signal is not blocked.
    const liveSub = resilientSubscription(pool, [relay], [liveFilter], {
      paginate: false,
      gapFill: true,
      settle: false,
      retryCount,
      gapFillBuffer,
      onRelaySettle: () => signal.settle(relay),
      onRelayError: () => signal.error(relay),
      // settle:false does not emit an EOSE sentinel. Use the wire callback.
      onRelayEose: () => {
        if (eoseSeen) return;
        eoseSeen = true;
        if (manualPaginate$) {
          signal.settle(relay);
          // A short live response may reflect a relay cap, not exhaustion.
          startPagination();
        } else {
          // Short pages can be relay caps. Reconnect EOSE must not restart us.
          startPagination();
        }
      },
    }).subscribe({
      next: (msg) => {
        if (msg === "EOSE") return;
        if (!eoseSeen) {
          if (oldestSeen === undefined || msg.created_at < oldestSeen)
            oldestSeen = msg.created_at;
        }
        subscriber.next(msg);
      },
      complete: () => {
        liveEnded = true;
        if (!paginateSub || historyDone || manualPaginate$)
          subscriber.complete();
      },
    });

    return () => {
      liveSub.unsubscribe();
      paginateSub?.unsubscribe();
    };
  });
}

function processBatch(
  pool: RelayPool,
  tagName: string,
  pointers: TagValuePointer[],
  opts: PaginatedTagValueLoaderOptions,
  exhausted: Set<string>,
  settleOpts: SettleSignalOptions,
): { events$: Observable<NostrEvent>; eose$: Observable<"EOSE"> } {
  const limit = opts.limit ?? 500;
  const retryCount = opts.retryCount ?? 3;
  const gapFillBuffer = opts.gapFillBuffer ?? 600;
  const relayFilterMap = buildRelayFilterMap(tagName, pointers, opts);
  const relayIds = Object.keys(relayFilterMap);

  const signal = makeSettleSignal({
    ...settleOpts,
    relayIds,
  });

  const perRelayStreams = relayIds.map((relay) => {
    const relayFilter = relayFilterMap[relay];
    const key = exhaustionKey(relay, tagName, relayFilter);
    const paginationFilter: TimelessFilter = { ...relayFilter };
    delete (paginationFilter as Filter).limit;

    return processRelayStream(
      pool,
      relay,
      relayFilter,
      paginationFilter,
      key,
      limit,
      retryCount,
      gapFillBuffer,
      exhausted,
      signal,
      opts.manualPaginate$,
      opts.onHistoryStatus,
    );
  });

  if (perRelayStreams.length === 0) {
    // relayIds is empty — makeSettleSignal fires eose$ immediately
    return { events$: EMPTY, eose$: signal.eose$ };
  }

  let combined: Observable<NostrEvent> = merge(...perRelayStreams);

  // Cache load (fire and forget alongside relay streams)
  if (opts.cacheRequest) {
    const filterTag = `#${tagName}` as keyof Filter;
    const allValues = pointers.map((p) => p.value);
    const cacheFilter: Filter = { [filterTag]: allValues };
    if (opts.kinds) cacheFilter.kinds = opts.kinds;
    const cache$ = makeCacheRequest(opts.cacheRequest, [
      cacheFilter,
    ]) as Observable<NostrEvent>;
    combined = merge(combined, cache$);
  }

  if (opts.eventStore) {
    combined = combined.pipe(
      mapEventsToStore(opts.eventStore),
      filterDuplicateEvents(opts.eventStore),
    ) as Observable<NostrEvent>;
  }

  return { events$: combined, eose$: signal.eose$ };
}

/**
 * Creates a paginated tag-value loader that is a drop-in replacement for
 * applesauce's createTagValueLoader.
 *
 * Returns Observable<NostrEvent | "EOSE">. Pipe through onlyEvents() if
 * the EOSE signal is not needed.
 *
 * - Batches pointers by bufferTime/bufferSize (same as createTagValueLoader)
 * - Opens a resilient live subscription per relay with exponential backoff,
 *   rate-limit handling, and permanent error fast-fail
 * - Paginates backward per relay until exhausted
 * - Skips already-exhausted relay+batch combos on subsequent calls
 * - Emits "EOSE" settleTime ms after the first relay finishes its current work
 */
export function createPaginatedTagValueLoader(
  pool: RelayPool,
  tagName: string,
  opts: PaginatedTagValueLoaderOptions = {},
): PaginatedTagValueLoader {
  const bufferMs = opts.bufferTime ?? 1000;
  const bufferMax = opts.bufferSize ?? 200;
  const settleMs = opts.settleTime ?? DEFAULT_SETTLE_TIME;

  // In-memory exhaustion tracking — resets on page reload
  const exhausted = new Set<string>();

  // Incoming pointer queue
  const queue = new Subject<TagValuePointer>();

  // Emits one shared observable per batch window
  const next = new Subject<Observable<PaginatedTagValueResponse>>();

  // Process each buffer window
  queue
    .pipe(bufferTime(bufferMs, undefined, bufferMax))
    .subscribe((pointers) => {
      if (pointers.length === 0) return;

      // Per-batch settle signal — created inside processBatch with relay count
      const settleOpts: SettleSignalOptions = { settleTime: settleMs };

      const { events$, eose$ } = processBatch(
        pool,
        tagName,
        pointers,
        opts,
        exhausted,
        settleOpts,
      );

      const upstream: Observable<PaginatedTagValueResponse> = merge(
        events$,
        eose$,
      ).pipe(
        // Keep alive as long as at least one caller is subscribed
        share({ resetOnRefCountZero: true }),
      );

      next.next(upstream);
    });

  // Each event is offered to every pointer in its batch. Signed event tags
  // must remain immutable, so share their index across pointers and later batches.
  // Weak keys let the index go when the event is no longer retained elsewhere.
  const tagValues = new WeakMap<NostrEvent, Set<string>>();
  const valuesOf = (event: NostrEvent): Set<string> => {
    let values = tagValues.get(event);
    if (!values) {
      values = new Set();
      for (const tag of event.tags) {
        if (tag[0] === tagName && tag[1] !== undefined) values.add(tag[1]);
      }
      tagValues.set(event, values);
    }
    return values;
  };

  return (pointer: TagValuePointer): Observable<PaginatedTagValueResponse> =>
    new Observable<PaginatedTagValueResponse>((observer) => {
      const sub = next
        .pipe(
          take(1),
          switchMap((batchObs) =>
            batchObs.pipe(
              // Pass "EOSE" through; filter events to only those relevant to
              // this pointer's tag value
              filter(
                (msg: PaginatedTagValueResponse) =>
                  msg === "EOSE" || valuesOf(msg).has(pointer.value),
              ),
            ),
          ),
        )
        .subscribe(observer);

      // Listen for the batch before adding the pointer. bufferTime emits
      // synchronously when bufferSize is reached, so queueing first can make
      // the pointer that fills the batch miss its own upstream observable.
      queue.next(pointer);

      return () => sub.unsubscribe();
    });
}
