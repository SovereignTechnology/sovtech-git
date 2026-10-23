/** Notification history: explicit batches, persistent per-relay/filter cursors. */
import {
  BehaviorSubject,
  Subject,
  of,
  type Observable,
  type Subscription,
} from "rxjs";
import type { EventStore } from "applesauce-core";
import type { RelayPool } from "applesauce-relay";
import type { TimelessFilter } from "applesauce-loaders";
import {
  resilientHistoryRequest,
  isHistoryTerminalError,
  HistoryAdmissionError,
} from "./resilientSubscription";
import {
  batchHistory,
  type HistoryBatch,
  type HistoryBatchResult,
} from "./batchHistory";

export interface ManualTimelineLoader {
  historyLoading$: BehaviorSubject<boolean>;
  /** True unless every known relay/filter has successfully exhausted history. */
  historyHasMore$: BehaviorSubject<boolean>;
  historyReachedArchive$: BehaviorSubject<boolean>;
  recheckArchiveCutoff: () => void;
  /** Ignored while the previous batch is in flight. Limits are per filter/relay. */
  loadMore: (limit: number) => void;
  destroy: () => void;
}
export interface ManualTimelineLoaderOptions {
  eventStore: EventStore;
  getArchiveCutoff?: () => number;
}

export function createManualTimelineLoader(
  pool: RelayPool,
  relays: Observable<string[]> | string[],
  filters: TimelessFilter[],
  opts: ManualTimelineLoaderOptions,
): ManualTimelineLoader {
  const historyLoading$ = new BehaviorSubject(false);
  const historyHasMore$ = new BehaviorSubject(false);
  const historyReachedArchive$ = new BehaviorSubject(false);
  const owners = new Map<
    string,
    {
      trigger: Subject<HistoryBatch>;
      sub: Subscription;
      result?: HistoryBatchResult;
    }
  >();
  let active = new Set<string>();
  let destroyed = false;

  function update() {
    if (active.size) return;
    historyLoading$.next(false);
    const results = [...owners.values()].map((owner) => owner.result);
    historyHasMore$.next(results.some((result) => !result?.exhausted));
    const cutoff = opts.getArchiveCutoff?.() ?? 0;
    historyReachedArchive$.next(
      cutoff > 0 &&
        results.length > 0 &&
        results.every(
          (result) =>
            result &&
            !result.incomplete &&
            result.filters.every(
              (f) =>
                f.exhausted || (f.oldest !== undefined && f.oldest <= cutoff),
            ),
        ),
    );
  }

  const relaySub = (Array.isArray(relays) ? of(relays) : relays).subscribe(
    (urls) => {
      for (const relay of urls) {
        if (owners.has(relay)) continue;
        const trigger = new Subject<HistoryBatch>();
        const sub = trigger
          .pipe(
            batchHistory(
              (_relays, pageFilters) =>
                resilientHistoryRequest(pool, relay, pageFilters, {
                  foreground: true,
                }),
              relay,
              filters,
              {
                isTerminalError: isHistoryTerminalError,
                isAdmissionError: (error) =>
                  error instanceof HistoryAdmissionError,
                onBatchComplete: (result) => {
                  const owner = owners.get(relay);
                  if (owner) owner.result = result;
                  active.delete(relay);
                  update();
                },
              },
            ),
          )
          .subscribe((event) => opts.eventStore.add(event));
        owners.set(relay, { trigger, sub });
      }
      // Late relays participate on the next trigger, without restarting old ones.
      // Their unknown coverage must reopen the archive/load-more affordance.
      historyReachedArchive$.next(false);
      update();
    },
  );

  return {
    historyLoading$,
    historyHasMore$,
    historyReachedArchive$,
    recheckArchiveCutoff: () => {
      historyReachedArchive$.next(false);
      update();
    },
    loadMore: (limit) => {
      if (destroyed || active.size) return;
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("History batch limit must be a positive integer");
      active = new Set(owners.keys());
      historyLoading$.next(active.size > 0);
      for (const { trigger } of owners.values()) trigger.next({ limit });
      update();
    },
    destroy: () => {
      destroyed = true;
      relaySub.unsubscribe();
      for (const { trigger, sub } of owners.values()) {
        sub.unsubscribe();
        trigger.complete();
      }
      active.clear();
      historyLoading$.next(false);
    },
  };
}
