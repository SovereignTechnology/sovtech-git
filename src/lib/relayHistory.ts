import type { RelayPool } from "applesauce-relay";
import type { Filter } from "applesauce-core/helpers";
import type { NostrRequest, TimelessFilter } from "applesauce-loaders";
import type { NostrEvent } from "nostr-tools";
import type { Observable } from "rxjs";
import { historyWindow, type HistoryWindowOptions } from "./historyWindow";

interface RelayHistoryPolicy {
  enabled: (relay: string) => boolean;
  hasInventory: (filter: Filter) => boolean;
  load: (
    relay: string,
    filters: TimelessFilter[],
    options: HistoryWindowOptions,
  ) => Observable<NostrEvent>;
}
const policies = new WeakMap<RelayPool, RelayHistoryPolicy>();

export function configureRelayHistory(
  pool: RelayPool,
  policy: RelayHistoryPolicy,
): void {
  policies.set(pool, policy);
}

export function hasRelayHistory(pool: RelayPool, relay: string): boolean {
  return policies.get(pool)?.enabled(relay) === true;
}

/** A warm owner listens for new events while an independent finite snapshot
 * reconciles history. Freeze this cursor per owner, never recompute on retry.
 */
export function historyLiveFilter(
  pool: RelayPool,
  relay: string,
  filter: Filter,
): Filter {
  const policy = policies.get(pool);
  if (
    // An unrestricted reference closure carries the visible thread's comments,
    // updates and essentials. It can batch the root with already-known children
    // on expansion/navigation, so keep its immediate snapshot for every batch.
    // Broad kind-scoped lists still avoid replaying cached event bodies.
    (!filter.kinds && ["#e", "#E", "#q"].some((tag) => tag in filter)) ||
    !policy?.enabled(relay) ||
    filter.since !== undefined ||
    filter.until !== undefined ||
    !policy.hasInventory(filter)
  )
    return filter;
  // Any matching inventory suppresses the initial historical snapshot, even a
  // single root fetched by a detail page. Arrival order can therefore move most
  // work into queued reconciliation. Classify benchmarks by this initial REQ
  // shape, not just by whether a later negotiation ran (it can run after a full
  // ordinary snapshot too). A smaller wire count alone does not prove readiness.
  // A bounded root bootstrap also feeds essentials/comment fan-out. A 20-root
  // experiment reduced the empty-cache burst but did not beat the sparse-cache
  // live-only path, and delayed discussion versus a full snapshot. Revisit sizing
  // alongside queue/coverage changes; see the comparison in the commit titled
  // "bench: evaluate bounded repository root snapshots".
  return { ...filter, since: Math.floor(Date.now() / 1000) };
}

export function loadRelayHistory(
  pool: RelayPool,
  request: NostrRequest,
  relay: string,
  filters: TimelessFilter[],
  options: HistoryWindowOptions,
): Observable<NostrEvent> {
  const policy = policies.get(pool);
  return policy?.enabled(relay)
    ? policy.load(relay, filters, options)
    : historyWindow(request, relay, filters, options);
}

/** Missing or unreadable NIP-11 is not permission to stall history on a
 * protocol the relay may silently ignore. Ordinary coverage stays available.
 */
export function advertisesNegentropy(pool: RelayPool, relay: string): boolean {
  return pool.relay(relay).information?.supported_nips?.includes(77) === true;
}
