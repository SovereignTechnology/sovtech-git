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
    // A focused, unrestricted thread query carries comments, updates and
    // essentials needed for first paint. Keep its immediate relay snapshot;
    // broader kind-scoped lists still avoid replaying cached event bodies.
    (!filter.kinds &&
      ["#e", "#E", "#q"].some(
        (tag) =>
          (filter[tag as keyof Filter] as string[] | undefined)?.length === 1,
      )) ||
    !policy?.enabled(relay) ||
    filter.since !== undefined ||
    filter.until !== undefined ||
    !policy.hasInventory(filter)
  )
    return filter;
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
