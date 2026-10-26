import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { Observable, Subscription, defer, type Subscriber } from "rxjs";
import { HistoryAdmissionError } from "./resilientSubscription";
import { normalizeUrl } from "./url";

export class MissingEventDownloadError extends Error {
  constructor() {
    super("Advertising relays did not deliver the negotiated event");
    this.name = "MissingEventDownloadError";
  }
}

interface Owner {
  pending: Set<string>;
  subscriber: Subscriber<NostrEvent>;
  accepts: (event: NostrEvent) => boolean;
  limit: number;
  priority: number;
}
interface Entry {
  id: string;
  owners: Set<Owner>;
  sources: Set<string>;
  tried: Set<string>;
  retryAt: Map<string, number>;
  queuedAt: number;
  batch?: Batch;
}
interface Batch {
  relay: string;
  entries: Entry[];
  subscription: Subscription;
  progress: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** One coordinator per history store/privacy scope, never a global ID cache.
 * Only completed negotiations may advertise sources. It shares body delivery,
 * not filter coverage or relay membership; each consumer validates its own view.
 * One active ID batch per relay prevents consumers multiplying requests; different
 * relays can transfer concurrently. Queued priority does not preempt an active batch.
 * Sharing changes arrival timing as well as traffic: see the commit titled
 * "perf(sync): share negotiated event downloads across history consumers" for
 * measured tradeoffs, and benchmarks/negotiation-admission-suite.json to recheck.
 */
export function createMissingEventDownloads(
  read: (ids: string[]) => NostrEvent[],
  request: (relay: string, filters: Filter[]) => Observable<NostrEvent>,
  onReceipt: (event: NostrEvent, relay: string) => void,
) {
  const entries = new Map<string, Entry>();
  const active = new Map<string, Batch>();
  let scheduled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  };
  const live = (entry: Entry) =>
    entries.get(entry.id) === entry && entry.owners.size > 0;
  const priority = (entry: Entry) =>
    Date.now() - entry.queuedAt >= 5_000
      ? -1
      : Math.min(...[...entry.owners].map((owner) => owner.priority));

  function deliver(entry: Entry, event: NostrEvent): boolean {
    let accepted = false;
    for (const owner of [...entry.owners]) {
      if (!owner.accepts(event)) continue;
      accepted = true;
      entry.owners.delete(owner);
      owner.pending.delete(entry.id);
      owner.subscriber.next(event);
      if (owner.pending.size === 0) owner.subscriber.complete();
    }
    // Delivery can synchronously cancel another owner and subscribe a new one
    // for the same ID. Never remove that replacement entry while retiring this one.
    if (entry.owners.size === 0 && entries.get(entry.id) === entry)
      entries.delete(entry.id);
    return accepted;
  }

  function finish(batch: Batch, error?: unknown) {
    if (batch.closed) return;
    batch.closed = true;
    clearTimeout(batch.timer);
    active.delete(batch.relay);
    batch.subscription.unsubscribe();
    for (const entry of batch.entries) {
      if (entry.batch !== batch) continue;
      entry.batch = undefined;
      if (error instanceof HistoryAdmissionError) {
        // Local admission is a postponement, not evidence that a source failed.
        entry.retryAt.set(batch.relay, Math.max(Date.now() + 1, error.retryAt));
      } else if (error || !batch.progress) {
        entry.tried.add(batch.relay);
      }
      // A short response with progress may be a relay cap. Retry residual IDs
      // through admission rather than declaring every omitted ID unavailable.
    }
    schedule();
  }

  function start(relay: string, selected: Entry[]) {
    // Earlier batches can synchronously populate the store during this pump.
    // Recheck at dispatch as well as when waking paused/failed entries.
    for (const event of read(selected.map((entry) => entry.id))) {
      const entry = entries.get(event.id);
      if (entry && !entry.batch) deliver(entry, event);
    }
    selected = selected.filter(live);
    if (!selected.length) return;
    const batch: Batch = {
      relay,
      entries: selected,
      subscription: new Subscription(),
      progress: false,
      closed: false,
    };
    active.set(relay, batch);
    for (const entry of selected) entry.batch = batch;
    const armStall = () => {
      clearTimeout(batch.timer);
      // Allow the admission queue's <=5s reservation plus 10s without useful
      // bodies before trying another advertiser. This is a client failover policy,
      // not proof of absence: a slow healthy source may be replaced. Only useful
      // bodies reset it; arbitrary/duplicate traffic cannot keep a
      // stalled source alive. This bounds inactivity for the batch, not total
      // waiting time for each ID: a useful trickle can keep residual IDs waiting.
      // The next source still uses normal relay admission.
      batch.timer = setTimeout(
        () => finish(batch, new MissingEventDownloadError()),
        15_000,
      );
    };
    armStall();
    const requested = new Map(selected.map((entry) => [entry.id, entry]));
    batch.subscription.add(
      defer(() => request(relay, [{ ids: [...requested.keys()] }])).subscribe({
        next: (event) => {
          const entry = requested.get(event.id);
          if (
            !entry ||
            !live(entry) ||
            ![...entry.owners].some((owner) => owner.accepts(event))
          )
            return;
          onReceipt(event, relay);
          const delivered = deliver(entry, event);
          batch.progress = delivered || batch.progress;
          if (batch.closed) return;
          if (selected.every((item) => !live(item))) finish(batch);
          else armStall();
        },
        error: (error: unknown) => finish(batch, error),
        complete: () => finish(batch),
      }),
    );
  }

  function pump() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    try {
      // Reuse bodies arriving from live subscriptions or unrelated queries,
      // including while a failed source was being tried. Reads stay bounded.
      // Active batches do not observe store arrivals; a body obtained elsewhere
      // is reused here only after that batch finishes or times out.
      const waiting = [...entries.values()].filter((entry) => !entry.batch);
      for (let offset = 0; offset < waiting.length; offset += 500) {
        for (const event of read(
          waiting.slice(offset, offset + 500).map((entry) => entry.id),
        )) {
          const entry = entries.get(event.id);
          if (entry && !entry.batch) deliver(entry, event);
        }
      }
      const pending = [...entries.values()]
        .filter((entry) => !entry.batch)
        .sort((a, b) => priority(a) - priority(b) || a.queuedAt - b.queuedAt);
      let earliestRetry = Infinity;
      for (const entry of pending) {
        if (!live(entry) || entry.batch) continue;
        const sources = [...entry.sources].filter(
          (relay) => !entry.tried.has(relay),
        );
        if (sources.length === 0) {
          for (const owner of [...entry.owners])
            owner.subscriber.error(new MissingEventDownloadError());
          continue;
        }
        const relay = sources.find(
          (source) =>
            !active.has(source) &&
            (entry.retryAt.get(source) ?? 0) <= Date.now(),
        );
        if (!relay) {
          for (const source of sources) {
            const at = entry.retryAt.get(source);
            if (!active.has(source) && at && at > Date.now())
              earliestRetry = Math.min(earliestRetry, at);
          }
          continue;
        }
        const limit = Math.min(
          500,
          ...[...entry.owners].map((owner) => owner.limit),
        );
        const selected = pending
          .filter(
            (item) =>
              live(item) &&
              !item.batch &&
              item.sources.has(relay) &&
              !item.tried.has(relay) &&
              (item.retryAt.get(relay) ?? 0) <= Date.now(),
          )
          .slice(0, limit);
        start(relay, selected);
      }
      if (Number.isFinite(earliestRetry))
        retryTimer = setTimeout(
          schedule,
          Math.max(1, earliestRetry - Date.now()),
        );
    } catch (error) {
      for (const entry of [...entries.values()]) {
        for (const owner of [...entry.owners]) owner.subscriber.error(error);
      }
    }
  }

  return (
    relay: string,
    ids: readonly string[],
    accepts: (event: NostrEvent) => boolean,
    options: { limit: number; priority: number },
  ): Observable<NostrEvent> =>
    new Observable((subscriber) => {
      const owner: Owner = {
        pending: new Set(ids),
        subscriber,
        accepts,
        limit: Math.max(1, options.limit),
        priority: options.priority,
      };
      if (!owner.pending.size) {
        subscriber.complete();
        return;
      }
      relay = normalizeUrl(relay);
      for (const id of owner.pending) {
        let entry = entries.get(id);
        if (!entry) {
          entry = {
            id,
            owners: new Set(),
            sources: new Set(),
            tried: new Set(),
            retryAt: new Map(),
            queuedAt: Date.now(),
          };
          entries.set(id, entry);
        }
        entry.owners.add(owner);
        entry.sources.add(relay);
      }
      schedule();
      return () => {
        for (const id of owner.pending) {
          const entry = entries.get(id);
          entry?.owners.delete(owner);
          if (entry?.owners.size === 0) entries.delete(id);
        }
        owner.pending.clear();
        // A departing consumer does not cancel another consumer's transfer.
        for (const batch of [...active.values()]) {
          if (batch.entries.every((entry) => !live(entry))) finish(batch);
        }
        schedule();
      };
    });
}
