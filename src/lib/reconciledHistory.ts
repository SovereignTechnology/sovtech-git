import type { IEventStore } from "applesauce-core";
import { compileFilter, type Filter } from "applesauce-core/helpers";
import type { RelayPool, NegentropyRound } from "applesauce-relay";
import type { TimelessFilter } from "applesauce-loaders";
import type { NostrEvent } from "nostr-tools";
import {
  Observable,
  Subscription,
  defer,
  from,
  concatMap,
  filter as rxFilter,
  catchError,
  retry,
  timer,
  throwError,
  tap,
  toArray,
  concatWith,
  EMPTY,
} from "rxjs";
import { historyWindow, type HistoryWindowOptions } from "./historyWindow";
import {
  HistoryAdmissionError,
  resilientHistoryRequest,
  resilientNegentropy,
} from "./resilientSubscription";
import { RelayEventPresence, relayEventPresence } from "./relayEventPresence";
import { normalizeUrl } from "./url";

export interface HistoryTransport {
  negotiate: (
    relay: string,
    inventory: NostrEvent[],
    filter: Filter,
  ) => Observable<NegentropyRound>;
  request: (relay: string, filters: Filter[]) => Observable<NostrEvent>;
}

/** Receive-only reconciliation with the existing coverage loader as fallback.
 * A pool-scoped instance serializes negotiations per relay. Transfer pages and
 * negotiations use the same admission/cooldown budget as ordinary history.
 */
export function createReconciledHistory(
  pool: RelayPool,
  store: Pick<IEventStore, "getByFilters">,
  presence: RelayEventPresence = relayEventPresence,
  transport: HistoryTransport = {
    negotiate: (relay, inventory, filter) =>
      resilientNegentropy(pool, relay, inventory, filter),
    request: (relay, filters) => resilientHistoryRequest(pool, relay, filters),
  },
) {
  const disabled = new Set<string>();
  // Keep negotiations serialized until their resulting downloads are coordinated.
  // Two-concurrent NEG experiments with separate start budgets, query priorities
  // and queue aging advanced cached history faster but did not protect foreground
  // readiness. Even the tighter policy delayed navigation comments (3.09 -> 4.77s
  // median) and increased EVENT traffic. These were two-pair captured replays,
  // not proof that parallel negotiation is intrinsically worse on every relay.
  // See `git show a156687a` for both policies, benefits, regressions and limitations;
  // rerun benchmarks/negotiation-admission-suite.json using benchmarks/README.md.
  // Revisit after shared missing-ID download ownership/fallback, a different
  // workload, or transport changes reduce the competing work. Compare accurate
  // repository convergence, foreground readiness and responsiveness together;
  // neither fewer missing events nor lower long-task totals alone is sufficient.
  const queues = new Map<
    string,
    { active: boolean; pending: (() => void)[] }
  >();
  function serialize<T>(
    relay: string,
    source: () => Observable<T>,
  ): Observable<T> {
    return new Observable((subscriber) => {
      let queue = queues.get(relay);
      if (!queue) queues.set(relay, (queue = { active: false, pending: [] }));
      const state = queue;
      let started = false;
      const owner = new Subscription();
      const start = () => {
        if (subscriber.closed) return;
        started = state.active = true;
        owner.add(defer(source).subscribe(subscriber));
      };
      subscriber.add(() => {
        owner.unsubscribe();
        if (started) {
          state.active = false;
          const next = state.pending.shift();
          if (next) next();
          else queues.delete(relay);
        } else {
          state.pending = state.pending.filter((item) => item !== start);
        }
      });
      if (state.active) state.pending.push(start);
      else start();
    });
  }
  const admissionRetry = <T>(source: Observable<T>) =>
    source.pipe(
      retry({
        delay: (error: unknown) =>
          error instanceof HistoryAdmissionError
            ? timer(Math.max(1, error.retryAt - Date.now()))
            : throwError(() => error),
      }),
    );

  return (
    relay: string,
    filters: TimelessFilter[],
    options: HistoryWindowOptions,
  ): Observable<NostrEvent> =>
    defer(() => {
      relay = normalizeUrl(relay);
      const window = {
        since: 0,
        until: Math.min(
          options.until ?? Math.floor(Date.now() / 1000),
          Math.floor(Date.now() / 1000),
        ),
      };
      let covered = true;
      return from(filters).pipe(
        concatMap((filter) =>
          defer(() => {
            const query = { ...filter, ...window };
            const matches = compileFilter(query);
            const inventory = [...store.getByFilters(query)];
            const local = new Set(inventory.map((event) => event.id));
            const started = presence.begin();
            const missing = new Set<string>();
            const received = new Set<string>();
            const status = (
              state: "loading" | "covered" | "incomplete",
              error?: unknown,
            ) =>
              options.onStatus?.({
                source: relay,
                filter,
                window,
                buffer: window,
                state,
                ...(error ? { reason: "request" as const, error } : {}),
              });
            const observe = (event: NostrEvent) => {
              received.add(event.id);
              missing.delete(event.id);
              presence.observe(event.id, relay);
            };
            const fallback = () =>
              historyWindow(
                (_relays, clauses) =>
                  transport
                    .request(relay, clauses)
                    .pipe(rxFilter(matches), tap(observe)),
                relay,
                [filter],
                {
                  ...options,
                  until: window.until,
                  onStatus: (value) => {
                    if (value.state !== "covered") options.onStatus?.(value);
                  },
                  onComplete: (complete) => {
                    const success = complete && missing.size === 0;
                    covered &&= success;
                    if (success)
                      presence.reconcile(relay, [...local], received, started);
                    status(
                      success ? "covered" : "incomplete",
                      success
                        ? undefined
                        : new Error(
                            "History did not establish complete relay membership",
                          ),
                    );
                  },
                },
              );
            // Cold stores use regular coverage requests; set reconciliation saves
            // transfer only when we already possess some of the matching bodies.
            if (disabled.has(relay) || inventory.length === 0)
              return fallback();
            status("loading");
            const have = new Set<string>();
            // This missing set belongs to one relay/filter snapshot: simultaneous
            // owners can download the same body. A future coordinator could share
            // in-flight ID batches, reuse bodies arriving elsewhere, and fall back
            // to another advertising relay on refusal, omission or bounded stall.
            // Start useful transfers before all negotiations finish. Keep relay
            // membership evidence independent of the relay serving the body, and
            // preserve cancellation/cooldowns and incomplete-history reporting.
            // This is an untested proposal, not the demonstrated cause of every
            // latency regression in the scheduling experiment noted above.
            const transfer = (): Observable<NostrEvent> =>
              defer(() => {
                if (missing.size === 0) return EMPTY;
                const ids = [...missing].slice(0, options.limit);
                const requested = new Set(ids);
                let progress = false;
                return admissionRetry(
                  defer(() => transport.request(relay, [{ ids }])),
                ).pipe(
                  concatMap((event) => {
                    if (!requested.has(event.id) || !matches(event))
                      return EMPTY;
                    progress = true;
                    observe(event);
                    return [event];
                  }),
                  concatWith(
                    defer(() => {
                      if (!progress)
                        return throwError(
                          () => new Error("Relay omitted negotiated event IDs"),
                        );
                      return transfer();
                    }),
                  ),
                );
              });
            return serialize(relay, () =>
              admissionRetry(
                defer(() => {
                  if (disabled.has(relay))
                    throw new Error(
                      "Reconciliation disabled for this relay session",
                    );
                  return transport.negotiate(relay, inventory, query);
                }),
              ),
            ).pipe(
              tap((round) => {
                for (const id of round.have) {
                  if (!local.has(id))
                    throw new Error("Invalid local reconciliation ID");
                  have.add(id);
                }
                for (const id of round.need) {
                  if (!/^[0-9a-f]{64}$/.test(id) || local.has(id))
                    throw new Error("Invalid remote reconciliation ID");
                  missing.add(id);
                }
              }),
              toArray(),
              concatMap((rounds) => {
                if (rounds.length === 0)
                  throw new Error("Negotiation ended without a terminal round");
                // Only terminal negotiation establishes the common set. Cached
                // bodies in it become visible without downloading duplicate EVENTs.
                presence.reconcile(
                  relay,
                  [...local],
                  new Set([...local].filter((id) => !have.has(id))),
                  started,
                );
                const common = inventory.filter((event) => !have.has(event.id));
                // Confirmed cached roots still drive their dependent loaders.
                // Emission here is not a new network receipt.
                return from(common).pipe(concatWith(transfer()));
              }),
              concatWith(
                defer(() => {
                  status("covered");
                  return EMPTY;
                }),
              ),
              catchError(() => {
                // A refusal disables further NEG work for this session, including
                // internal rounds whose pacing belongs to the dependency. Cooldown
                // remains in the shared ledger; fallback cannot bypass it.
                disabled.add(relay);
                return fallback();
              }),
            );
          }),
        ),
        concatWith(
          defer(() => {
            options.onComplete?.(covered);
            return EMPTY;
          }),
        ),
      );
    });
}
