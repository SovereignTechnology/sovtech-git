import { isFilterEqual, compileFilter } from "applesauce-core/helpers/filter";
import {
  loadBlocksFromRelay,
  type TimelineStatus,
} from "applesauce-loaders/loaders";
import type { NostrRequest, TimelessFilter } from "applesauce-loaders";
import type { NostrEvent } from "nostr-tools";
import {
  Observable,
  defer,
  Subject,
  type OperatorFunction,
  type Subscription,
  tap,
} from "rxjs";

export interface HistoryBatch {
  limit: number;
  until?: number;
}
export interface HistoryBatchResult {
  /** Successful coverage through the bottom, independently for every filter. */
  exhausted: boolean;
  incomplete: boolean;
  /** Archive cutoffs must be checked per filter, not against the sparsest one. */
  filters: { exhausted: boolean; oldest?: number }[];
}
export interface BatchHistoryOptions {
  retryCount?: number;
  isTerminalError?: (error: unknown) => boolean;
  isAdmissionError?: (error: unknown) => boolean;
  onStatus?: (status: TimelineStatus) => void;
  onBatchComplete?: (result: HistoryBatchResult) => void;
}

/**
 * Explicit batches over v7's coverage engine. A point window fills a request
 * below the cursor without asking v7 to drain an arbitrary span of history.
 * Each filter owns its cursor: a sparse filter must not skip a dense one's gap.
 * Inclusive boundary checks may need extra requests. No prefetch runs between
 * triggers. Transient failures retry this batch, without advancing its cursor.
 * Terminal failures settle incomplete; a later trigger can retry that cursor.
 * Limits count raw events per filter/relay, including boundary duplicates; they
 * do not promise new visible cards or a complete merged chronological interval.
 */
export function batchHistory(
  request: NostrRequest,
  relay: string,
  filters: TimelessFilter[],
  options: BatchHistoryOptions = {},
): OperatorFunction<HistoryBatch, NostrEvent> {
  return (source) =>
    new Observable((subscriber) => {
      let destroyed = false;
      let busy = false;
      let batchLimit = 100;
      let remaining = 0;
      let incomplete = false;
      const seen = new Set<string>();
      const states = filters
        .filter((f, i) => !filters.slice(0, i).some((p) => isFilterEqual(p, f)))
        .map((filter) => ({
          filter,
          windows: new Subject<{ since: number; until: number }>(),
          sub: undefined as Subscription | undefined,
          cursor: undefined as number | undefined,
          oldest: undefined as number | undefined,
          pageOldest: undefined as number | undefined,
          exhausted: false,
          pending: false,
          finishing: false,
          failures: 0,
          countedFailure: false,
        }));

      function finishBatch() {
        busy = false;
        options.onBatchComplete?.({
          exhausted: states.every((s) => s.exhausted),
          incomplete,
          filters: states.map(({ exhausted, oldest }) => ({
            exhausted,
            oldest,
          })),
        });
      }
      function startEngine(state: (typeof states)[number]) {
        state.sub = state.windows
          .pipe(
            loadBlocksFromRelay(
              (urls, pageFilters) =>
                defer(() => {
                  state.countedFailure = false;
                  let oldest: number | undefined;
                  const matches = pageFilters.map((f) => compileFilter(f));
                  return request(
                    urls,
                    pageFilters.map((f) => ({ ...f, limit: batchLimit })),
                  ).pipe(
                    tap({
                      next: (event) => {
                        if (matches.some((match) => match(event)))
                          oldest = Math.min(
                            oldest ?? Infinity,
                            event.created_at,
                          );
                      },
                      complete: () => {
                        state.failures = 0;
                        // Partial failed attempts must not pull the next cursor
                        // below the range proven by the successful retry.
                        if (oldest !== undefined)
                          state.pageOldest = Math.min(
                            state.pageOldest ?? Infinity,
                            oldest,
                          );
                      },
                    }),
                  );
                }),
              relay,
              [state.filter],
              {
                limit: 100,
                prefetch: 0,
                responseTimeout: 160_000,
                onStatus: (status) => {
                  options.onStatus?.(status);
                  if (
                    !state.pending ||
                    state.finishing ||
                    (status.state !== "covered" &&
                      status.state !== "incomplete")
                  )
                    return;
                  if (
                    status.state === "incomplete" &&
                    status.reason === "request"
                  ) {
                    const admission =
                      options.isAdmissionError?.(status.error) ?? false;
                    if (!state.countedFailure) {
                      state.countedFailure = true;
                      if (!admission) state.failures++;
                    }
                    if (
                      !options.isTerminalError?.(status.error) &&
                      (admission || state.failures <= (options.retryCount ?? 3))
                    )
                      return;
                  }
                  state.finishing = true;
                  // Let v7 finish committing its page before reacting to the status.
                  queueMicrotask(() => {
                    if (destroyed) return;
                    state.finishing = false;
                    state.pending = false;
                    if (status.state === "incomplete") {
                      incomplete = true;
                      // Stop automatic retries. Retain the cursor, but discard failed
                      // engine state so another explicit trigger can retry it.
                      state.sub?.unsubscribe();
                      state.sub = undefined;
                    } else {
                      state.exhausted = state.pageOldest === undefined;
                      if (state.pageOldest !== undefined) {
                        state.oldest = Math.min(
                          state.oldest ?? Infinity,
                          state.pageOldest,
                        );
                        // Keep the oldest second until v7 proves it covered. If a
                        // boundary-only batch is covered, the next trigger can cross it.
                        state.cursor =
                          state.pageOldest < state.cursor!
                            ? state.pageOldest
                            : state.cursor! - 1;
                        if (state.cursor < 0) state.exhausted = true;
                      }
                    }
                    if (--remaining === 0) finishBatch();
                  });
                },
              },
            ),
          )
          .subscribe({
            next: (event) => {
              if (!seen.has(event.id)) {
                seen.add(event.id);
                subscriber.next(event);
              }
            },
            error: (error: unknown) => subscriber.error(error),
          });
      }
      const triggers = source.subscribe({
        next: ({ limit, until }) => {
          if (busy) return;
          if (!Number.isSafeInteger(limit) || limit <= 0) {
            subscriber.error(
              new Error("History batch limit must be a positive integer"),
            );
            return;
          }
          busy = true;
          // A lower request limit invalidates v7's observed source-cap evidence.
          // Keep cursors but re-prove coverage rather than treating the smaller
          // boundary response as proof that the relay had nothing else.
          if (limit < batchLimit) {
            for (const state of states) {
              state.sub?.unsubscribe();
              state.sub = undefined;
            }
          }
          batchLimit = limit;
          incomplete = false;
          const pending = states.filter((s) => !s.exhausted);
          remaining = pending.length;
          if (!remaining) {
            finishBatch();
            return;
          }
          for (const state of pending) {
            state.cursor ??= Math.min(
              until ?? Math.floor(Date.now() / 1000),
              Math.floor(Date.now() / 1000),
            );
            state.pageOldest = undefined;
            state.failures = 0;
            state.pending = true;
            if (!state.sub) startEngine(state);
            state.windows.next({ since: state.cursor, until: state.cursor });
          }
        },
        error: (error: unknown) => subscriber.error(error),
        // The owner tears down the persistent engine; trigger completion does not
        // cancel an outstanding batch.
      });
      return () => {
        destroyed = true;
        triggers.unsubscribe();
        for (const state of states) {
          state.sub?.unsubscribe();
          state.windows.complete();
        }
      };
    });
}
