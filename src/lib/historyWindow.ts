import { isFilterEqual } from "applesauce-core/helpers/filter";
import {
  loadBlocksFromRelay,
  type TimelineStatus,
} from "applesauce-loaders/loaders";
import type { NostrRequest, TimelessFilter } from "applesauce-loaders";
import {
  EMPTY,
  BehaviorSubject,
  Observable,
  Subject,
  defer,
  distinct,
  finalize,
  takeUntil,
} from "rxjs";
import type { NostrEvent } from "nostr-tools";

export interface HistoryWindowOptions {
  limit: number;
  until?: number;
  onStatus?: (status: TimelineStatus) => void;
  isTerminalError: (error: unknown) => boolean;
  onComplete?: (covered: boolean) => void;
}

/**
 * Drain a historical snapshot with v7 coverage tracking. The request callback
 * must preserve errors and must not wait through relay cooldowns. Live updates
 * and foreground gap-fill remain the caller's responsibility. A snapshot can
 * contain arbitrarily many events: admission bounds pressure, not total work.
 * Completion is relative to these relays, not all events or future backfills.
 */
export function historyWindow(
  request: NostrRequest,
  relay: string,
  filters: TimelessFilter[],
  options: HistoryWindowOptions,
): Observable<NostrEvent> {
  return defer(() => {
    const uniqueFilters = filters.filter(
      (filter, index) =>
        !filters
          .slice(0, index)
          .some((previous) => isFilterEqual(previous, filter)),
    );
    if (uniqueFilters.length === 0) {
      options.onComplete?.(true);
      return EMPTY;
    }
    const windows = new BehaviorSubject({
      since: 0,
      until: Math.min(
        options.until ?? Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      ),
    });
    const done = new Subject<void>();
    const statuses = new Map<string, TimelineStatus>();
    let finished = false;
    return windows.pipe(
      loadBlocksFromRelay(request, relay, uniqueFilters, {
        limit: options.limit,
        prefetch: 0,
        // Cooldowns are immediate admission errors, not time spent waiting here.
        // Bound a silent attempt including up to 5s pacing and auth overhead;
        // the request itself has its own 120s operation budget.
        responseTimeout: 160_000,
        retryDelay: 5_000,
        onStatus: (status) => {
          statuses.set(JSON.stringify(status.filter), status);
          options.onStatus?.(status);
          const values = [...statuses.values()];
          const terminal =
            values.length === uniqueFilters.length &&
            values.every(
              (s) =>
                s.state === "covered" ||
                (s.state === "incomplete" &&
                  (s.reason === "boundary" ||
                    options.isTerminalError(s.error))),
            );
          if (terminal && !finished) {
            finished = true;
            options.onComplete?.(values.every((s) => s.state === "covered"));
            done.next();
          }
        },
      }),
      distinct((event) => event.id),
      takeUntil(done),
      finalize(() => {
        windows.complete();
        done.complete();
      }),
    );
  });
}
