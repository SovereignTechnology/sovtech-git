import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import {
  fakeVerifyEvent,
  matchFilter,
  type Filter,
} from "applesauce-core/helpers";
import { RelayPool, RelayClosedError } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import {
  EMPTY,
  Observable,
  finalize,
  NEVER,
  Subject,
  firstValueFrom,
  of,
  throwError,
  timeout,
  toArray,
} from "rxjs";
import {
  createReconciledHistory,
  type HistoryTransport,
} from "./reconciledHistory";
import {
  createMissingEventDownloads,
  MissingEventDownloadError,
} from "./missingEventDownloads";
import { RelayEventPresence } from "./relayEventPresence";
import {
  getRateLimitCooldownRemaining,
  HistoryAdmissionError,
  resilientNegentropy,
} from "./resilientSubscription";

const relay = "wss://sync.test";
const event = (id: number, time = 100): NostrEvent => ({
  id: id.toString(16).padStart(64, "0"),
  pubkey: "a".repeat(64),
  kind: 1621,
  created_at: time,
  tags: [["a", "repo"]],
  content: "body",
  sig: "b".repeat(128),
});
const options = () => ({
  limit: 2,
  until: 120,
  isTerminalError: () => true,
  onComplete: vi.fn(),
  onStatus: vi.fn(),
});
const stores: EventStore[] = [];
const pools: RelayPool[] = [];
function setup(events: NostrEvent[], transport: HistoryTransport) {
  const store = new EventStore();
  store.verifyEvent = fakeVerifyEvent;
  events.forEach((e) => store.add(e));
  stores.push(store);
  const pool = new RelayPool();
  pools.push(pool);
  const presence = new RelayEventPresence();
  return {
    store,
    presence,
    load: createReconciledHistory(pool, store, presence, transport),
  };
}
const collect = (
  stream: ReturnType<ReturnType<typeof createReconciledHistory>>,
) => firstValueFrom(stream.pipe(timeout(3000), toArray()));
afterEach(() => {
  stores.splice(0).forEach((s) => s.dispose());
  pools.splice(0).forEach((p) => p.close());
  vi.restoreAllMocks();
});

describe("receive-only reconciled history", () => {
  it("confirms common cached events with no EVENT download and withdraws absent membership", async () => {
    const [a, b] = [event(1), event(2)];
    const request = vi.fn(() => EMPTY);
    const { load, presence } = setup([a, b], {
      negotiate: () => of({ have: [b.id], need: [] }),
      request,
    });
    presence.observe(b.id, relay);
    const opts = options();
    expect(await collect(load(relay, [{ kinds: [1621] }], opts))).toEqual([a]);
    expect(presence.has(a.id, [relay + "/"])).toBe(true);
    expect(presence.has(b.id, [relay])).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(opts.onComplete).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("fetches only missing IDs, follows short ID responses and retains timestamp collisions", async () => {
    const events = [event(1), event(2), event(3), event(4)];
    const request = vi.fn((_relay: string, filters: Filter[]) =>
      of(...events.filter((e) => matchFilter(filters[0], e)).slice(0, 1)),
    );
    const { load, presence } = setup(events.slice(0, 1), {
      negotiate: () => of({ have: [], need: events.slice(1).map((e) => e.id) }),
      request,
    });
    const opts = options();
    expect(
      (await collect(load(relay, [{ kinds: [1621] }], opts))).map((e) => e.id),
    ).toEqual(events.map((e) => e.id));
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      request.mock.calls.every(
        ([, filters]) => !filters[0].ids?.includes(events[0].id),
      ),
    ).toBe(true);
    expect(events.every((e) => presence.has(e.id, [relay]))).toBe(true);
    expect(opts.onComplete).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("reuses bodies arriving during negotiation without inventing fresh relay receipts", async () => {
    const rounds = new Subject<{ have: string[]; need: string[] }>();
    const request = vi.fn(() => EMPTY);
    const { store, load, presence } = setup([event(1)], {
      negotiate: () => rounds,
      request,
    });
    const result = collect(load(relay, [{ kinds: [1621] }], options()));
    store.add(event(2));
    store.add(event(3));
    // A newer absence check must win over this older negotiation's evidence.
    presence.reconcile(relay, [event(3).id], new Set(), presence.begin());
    rounds.next({ have: [], need: [event(2).id, event(3).id] });
    rounds.complete();
    expect((await result).map((e) => e.id)).toEqual([
      event(1).id,
      event(2).id,
      event(3).id,
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(presence.has(event(2).id, [relay])).toBe(true);
    expect(presence.has(event(3).id, [relay])).toBe(false);
  });

  it("releases a stalled negotiated body from the store without fresh relay evidence", async () => {
    const cancelled = vi.fn();
    const request = vi.fn(() => NEVER.pipe(finalize(cancelled)));
    const { load, store, presence } = setup([event(1)], {
      negotiate: () => of({ have: [], need: [event(2).id] }),
      request,
    });
    const receipt = vi.spyOn(presence, "observe");
    const pending = collect(load(relay, [{ kinds: [1621] }], options()));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    // A newer absence check must still beat the original negotiation's evidence.
    presence.reconcile(relay, [event(2).id], new Set(), presence.begin());
    store.add(event(2));
    expect(await pending).toEqual([event(1), event(2)]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(receipt).not.toHaveBeenCalled();
    expect(presence.has(event(2).id, [relay])).toBe(false);
  });

  it("rechecks cached bodies after a local admission refusal", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(() => {
        store.add(event(2));
        return throwError(() => new HistoryAdmissionError(Date.now() + 100));
      });
      const setupResult = setup([event(1)], {
        negotiate: () => of({ have: [], need: [event(2).id] }),
        request,
      });
      const store = setupResult.store;
      const result = collect(
        setupResult.load(relay, [{ kinds: [1621] }], options()),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect((await result).map((e) => e.id)).toEqual([
        event(1).id,
        event(2).id,
      ]);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks later batches but never reuses bodies outside the negotiated filter", async () => {
    const request = vi.fn((_relay: string, filters: Filter[]) => {
      if (filters[0].ids?.includes(event(2).id)) {
        store.add(event(3));
        return of(event(2));
      }
      return EMPTY;
    });
    const setupResult = setup([event(1)], {
      negotiate: () => of({ have: [], need: [event(2).id, event(3).id] }),
      request,
    });
    const store = setupResult.store;
    const result = await collect(
      setupResult.load(relay, [{ kinds: [1621] }], { ...options(), limit: 1 }),
    );
    expect(result.map((e) => e.id)).toEqual([
      event(1).id,
      event(2).id,
      event(3).id,
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    const mismatch = setup([event(1), { ...event(4), kind: 1 }], {
      negotiate: () => of({ have: [], need: [event(4).id] }),
      request: () => EMPTY,
    });
    const opts = options();
    await collect(mismatch.load(relay, [{ kinds: [1621] }], opts));
    expect(opts.onComplete).toHaveBeenCalledExactlyOnceWith(false);
    expect(mismatch.presence.has(event(4).id, [relay])).toBe(false);
  });

  it("shares cross-filter bodies while retaining independent relay membership revisions", async () => {
    const response = new Subject<NostrEvent>();
    const request = vi.fn(() => response);
    const { load, presence } = setup([event(1)], {
      negotiate: () => of({ have: [], need: [event(2).id] }),
      request,
    });
    const other = "wss://other.test";
    const one = collect(load(relay, [{ kinds: [1621] }], options()));
    const two = collect(load(other, [{ "#a": ["repo"] }], options()));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    presence.reconcile(other, [event(2).id], new Set(), presence.begin());
    response.next(event(2));
    expect((await one).map((e) => e.id)).toEqual([event(1).id, event(2).id]);
    expect((await two).map((e) => e.id)).toEqual([event(1).id, event(2).id]);
    expect(presence.has(event(2).id, [relay])).toBe(true);
    expect(presence.has(event(2).id, [other])).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not call an omitted negotiated ID complete even when fallback is empty", async () => {
    const missing = event(2);
    const request = vi.fn(() => EMPTY);
    const { load } = setup([event(1)], {
      negotiate: () => of({ have: [], need: [missing.id] }),
      request,
    });
    const opts = options();
    await collect(load(relay, [{ kinds: [1621] }], opts));
    expect(opts.onComplete).toHaveBeenCalledExactlyOnceWith(false);
    expect(opts.onStatus.mock.calls.at(-1)?.[0].state).toBe("incomplete");
  });

  it("falls back on unsupported negotiation without hiding a saturated timestamp", async () => {
    const events = [event(1), event(2), event(3)];
    const negotiate = vi.fn(() => throwError(() => new Error("unsupported")));
    const request = vi.fn((_relay: string, filters: Filter[]) =>
      of(...events.filter((e) => matchFilter(filters[0], e)).slice(0, 2)),
    );
    const { load, presence } = setup(events, { negotiate, request });
    const opts = options();
    await collect(load(relay, [{ kinds: [1621] }], opts));
    expect(opts.onComplete).toHaveBeenCalledExactlyOnceWith(false);
    expect(presence.has(events[2].id, [relay])).toBe(false);
    await collect(load(relay, [{ kinds: [1621] }], options()));
    expect(negotiate).toHaveBeenCalledTimes(1);
  });

  it("does not infer common membership from an empty negotiation completion", async () => {
    const { load, presence } = setup([event(1)], {
      negotiate: () => EMPTY,
      request: () => EMPTY,
    });
    await collect(load(relay, [{ kinds: [1621] }], options()));
    expect(presence.has(event(1).id, [relay])).toBe(false);
  });

  it("cancellation never establishes absence or calls completion", () => {
    const { load, presence } = setup([event(1)], {
      negotiate: () => NEVER,
      request: () => EMPTY,
    });
    presence.observe(event(1).id, relay);
    const opts = options();
    const sub = load(relay, [{ kinds: [1621] }], opts).subscribe();
    sub.unsubscribe();
    expect(presence.has(event(1).id, [relay])).toBe(true);
    expect(opts.onComplete).not.toHaveBeenCalled();
  });

  it("serializes negotiation and cancels queued owners without starting them", () => {
    const negotiate = vi.fn(
      () => new Subject<{ have: string[]; need: string[] }>(),
    );
    const { load } = setup([event(1)], { negotiate, request: () => EMPTY });
    const one = load(relay, [{ kinds: [1621] }], options()).subscribe();
    const two = load(relay, [{ kinds: [1621] }], options()).subscribe();
    const three = load(relay, [{ kinds: [1621] }], options()).subscribe();
    expect(negotiate).toHaveBeenCalledTimes(1);
    two.unsubscribe();
    one.unsubscribe();
    expect(negotiate).toHaveBeenCalledTimes(2);
    three.unsubscribe();
  });

  it("sends queued owners to fallback after an earlier negotiation is refused", async () => {
    const rounds = new Subject<{ have: string[]; need: string[] }>();
    const negotiate = vi.fn(() => rounds);
    const request = vi.fn(() => EMPTY);
    const { load } = setup([event(1)], { negotiate, request });
    const one = collect(load(relay, [{ kinds: [1621] }], options()));
    const two = collect(load(relay, [{ kinds: [1621] }], options()));
    rounds.error(new Error("unsupported"));
    await Promise.all([one, two]);
    expect(negotiate).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares rate-limit cooldown for NEG refusals", async () => {
    const pool = new RelayPool();
    pools.push(pool);
    const url = "wss://neg-cooldown.test";
    const connection = pool.relay(url);
    vi.spyOn(connection, "negentropy").mockReturnValue(
      throwError(() => new RelayClosedError("rate-limited: too many queries")),
    );
    await expect(
      firstValueFrom(resilientNegentropy(pool, url, [], { kinds: [1621] })),
    ).rejects.toThrow("rate-limited");
    expect(getRateLimitCooldownRemaining(url)).toBeGreaterThan(60000);
    await expect(
      firstValueFrom(resilientNegentropy(pool, url, [], { kinds: [1621] })),
    ).rejects.toThrow("admission");
    expect(connection.negentropy).toHaveBeenCalledTimes(1);
  });
});

describe("relay membership evidence", () => {
  it("does not let old reconciliation erase a newer live receipt or newer reconciliation", () => {
    const presence = new RelayEventPresence();
    const id = event(1).id;
    const old = presence.begin();
    presence.observe(id, relay);
    presence.reconcile(relay, [id], new Set(), old);
    expect(presence.has(id, [relay])).toBe(true);
    const earlier = presence.begin(),
      later = presence.begin();
    presence.reconcile(relay, [id], new Set(), later);
    presence.reconcile(relay, [id], new Set([id]), earlier);
    expect(presence.has(id, [relay])).toBe(false);
  });
});

describe("shared negotiated body downloads", () => {
  const other = "wss://other.test";
  const accepts = (e: NostrEvent) => e.kind === 1621;
  const downloadOptions = { limit: 2, priority: 1 };
  const result = (stream: Observable<NostrEvent>) =>
    firstValueFrom(stream.pipe(timeout(3000), toArray()));

  it("shares overlapping IDs across filters/relays while still batching distinct IDs", async () => {
    const a = new Subject<NostrEvent>();
    const b = new Subject<NostrEvent>();
    const request = vi.fn((source: string, _filters: Filter[]) =>
      source === relay ? a : b,
    );
    const receipt = vi.fn();
    const download = createMissingEventDownloads(() => [], request, receipt);
    const one = result(
      download(relay, [event(1).id, event(2).id], accepts, downloadOptions),
    );
    const two = result(
      download(other, [event(2).id, event(3).id], accepts, downloadOptions),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls).toEqual([
      [relay, [{ ids: [event(1).id, event(2).id] }]],
      [other, [{ ids: [event(3).id] }]],
    ]);
    a.next(event(1));
    a.next(event(2));
    b.next(event(3));
    expect((await one).map((e) => e.id)).toEqual([event(1).id, event(2).id]);
    expect((await two).map((e) => e.id)).toEqual([event(2).id, event(3).id]);
    expect(receipt).toHaveBeenCalledTimes(3);
  });

  it("retains replacement demand created synchronously during delivery", async () => {
    const response = new Subject<NostrEvent>();
    const request = vi.fn(() => response);
    let cached: NostrEvent[] = [];
    const download = createMissingEventDownloads(
      () => cached,
      request,
      () => undefined,
    );
    let replacement: Promise<NostrEvent[]> | undefined;
    const first = download(
      relay,
      [event(1).id],
      accepts,
      downloadOptions,
    ).subscribe(() => {
      cached = [event(1)];
      second.unsubscribe();
      replacement = result(
        download(other, [event(1).id], accepts, downloadOptions),
      );
    });
    const second = download(
      other,
      [event(1).id],
      accepts,
      downloadOptions,
    ).subscribe();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    response.next(event(1));
    expect(replacement).toBeDefined();
    expect(await replacement).toEqual([event(1)]);
    expect(request).toHaveBeenCalledTimes(1);
    first.unsubscribe();
  });

  it("keeps a shared request when one consumer leaves and cancels it when the last leaves", async () => {
    const response = new Subject<NostrEvent>();
    const closed = vi.fn();
    const request = vi.fn(() => response.pipe(finalize(closed)));
    const download = createMissingEventDownloads(
      () => [],
      request,
      () => undefined,
    );
    const one = download(
      relay,
      [event(1).id],
      accepts,
      downloadOptions,
    ).subscribe();
    const two = download(
      other,
      [event(1).id],
      accepts,
      downloadOptions,
    ).subscribe();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    one.unsubscribe();
    expect(closed).not.toHaveBeenCalled();
    two.unsubscribe();
    expect(closed).toHaveBeenCalledTimes(1);
    const three = result(
      download(other, [event(1).id], accepts, downloadOptions),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    response.next(event(1));
    expect(await three).toEqual([event(1)]);
  });

  it.each(["omission", "refusal"])(
    "falls back to another advertiser after %s",
    async (mode) => {
      const response = new Subject<NostrEvent>();
      const request = vi.fn((source: string) =>
        source === relay ? response : of(event(1)),
      );
      const download = createMissingEventDownloads(
        () => [],
        request,
        () => undefined,
      );
      const one = result(
        download(relay, [event(1).id], accepts, downloadOptions),
      );
      const two = result(
        download(other, [event(1).id], accepts, downloadOptions),
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      if (mode === "omission") response.complete();
      else response.error(new Error("rate-limited"));
      expect(await one).toEqual([event(1)]);
      expect(await two).toEqual([event(1)]);
      expect(request.mock.calls.map(([source]) => source)).toEqual([
        relay,
        other,
      ]);
    },
  );

  it("falls back after bounded inactivity and cancels the stalled request", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const request = vi.fn((source: string) =>
        source === relay ? NEVER.pipe(finalize(cancelled)) : of(event(1)),
      );
      const download = createMissingEventDownloads(
        () => [],
        request,
        () => undefined,
      );
      const one = firstValueFrom(
        download(relay, [event(1).id], accepts, downloadOptions).pipe(
          toArray(),
        ),
      );
      const two = firstValueFrom(
        download(other, [event(1).id], accepts, downloadOptions).pipe(
          toArray(),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await one).toEqual([event(1)]);
      expect(await two).toEqual([event(1)]);
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets disjoint work progress while a useful trickle delays shared residual IDs", async () => {
    vi.useFakeTimers();
    try {
      const slow = new Subject<NostrEvent>();
      const request = vi.fn((source: string, filters: Filter[]) =>
        source === relay
          ? slow
          : of(
              ...[event(2), event(3)].filter((e) =>
                filters[0].ids?.includes(e.id),
              ),
            ),
      );
      const download = createMissingEventDownloads(
        () => [],
        request,
        () => undefined,
      );
      const received: string[] = [];
      const one = firstValueFrom(
        download(
          relay,
          [event(1).id, event(2).id],
          accepts,
          downloadOptions,
        ).pipe(toArray()),
      );
      const two = download(
        other,
        [event(1).id, event(2).id, event(3).id],
        accepts,
        downloadOptions,
      ).subscribe((e) => received.push(e.id));
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toEqual([event(3).id]);
      expect(request.mock.calls).toEqual([
        [relay, [{ ids: [event(1).id, event(2).id] }]],
        [other, [{ ids: [event(3).id] }]],
      ]);
      // This is an inactivity deadline, not a maximum age for each pending ID.
      await vi.advanceTimersByTimeAsync(14_000);
      slow.next(event(1));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(request).toHaveBeenCalledTimes(2);
      slow.next(event(1)); // A duplicate cannot extend the remaining ID's wait.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await one).toEqual([event(1), event(2)]);
      expect(received).toEqual([event(3).id, event(1).id, event(2).id]);
      expect(request.mock.calls[2]).toEqual([other, [{ ids: [event(2).id] }]]);
      expect(two.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one store listener and retains a partial transfer until all pending IDs arrive", async () => {
    const arrivals = new Subject<NostrEvent>();
    const response = new Subject<NostrEvent>();
    const cached = new Map<string, NostrEvent>();
    const read = vi.fn((ids: string[]) =>
      ids.flatMap((id) => {
        const value = cached.get(id);
        return value ? [value] : [];
      }),
    );
    const cancelled = vi.fn();
    const request = vi.fn(() => response.pipe(finalize(cancelled)));
    const receipt = vi.fn();
    let listeners = 0;
    const notifications = new Observable<NostrEvent>((subscriber) => {
      listeners++;
      const sub = arrivals.subscribe(subscriber);
      return () => {
        sub.unsubscribe();
        listeners--;
      };
    });
    const download = createMissingEventDownloads(
      read,
      request,
      receipt,
      notifications,
    );
    const one: NostrEvent[] = [],
      two: NostrEvent[] = [];
    const a = download(
      relay,
      [event(1).id, event(2).id],
      accepts,
      downloadOptions,
    ).subscribe((e) => one.push(e));
    const b = download(
      other,
      [event(2).id],
      accepts,
      downloadOptions,
    ).subscribe((e) => two.push(e));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(listeners).toBe(1);
    read.mockClear();
    arrivals.next(event(99));
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    cached.set(event(1).id, event(1));
    arrivals.next(event(1));
    await vi.waitFor(() => expect(one).toEqual([event(1)]));
    expect(cancelled).not.toHaveBeenCalled();
    expect(two).toEqual([]);
    cached.set(event(2).id, event(2));
    arrivals.next(event(2));
    await vi.waitFor(() => expect(a.closed && b.closed).toBe(true));
    expect(one).toEqual([event(1), event(2)]);
    expect(two).toEqual([event(2)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(receipt).not.toHaveBeenCalled();
    expect(listeners).toBe(0);
    const next = download(
      relay,
      [event(3).id],
      accepts,
      downloadOptions,
    ).subscribe();
    expect(listeners).toBe(1);
    next.unsubscribe();
    expect(listeners).toBe(0);
  });

  it("rechecks scope visibility and consumer filters before waking a cached ID", async () => {
    const arrivals = new Subject<NostrEvent>();
    const cached: NostrEvent[] = [];
    const receipt = vi.fn();
    const request = vi.fn(() => NEVER);
    const publicDownload = createMissingEventDownloads(
      () => [],
      request,
      receipt,
      arrivals,
    );
    const privateDownload = createMissingEventDownloads(
      () => cached,
      request,
      receipt,
      arrivals,
    );
    const publicValues: NostrEvent[] = [],
      rejectedValues: NostrEvent[] = [];
    const publicOwner = publicDownload(
      relay,
      [event(1).id],
      accepts,
      downloadOptions,
    ).subscribe((e) => publicValues.push(e));
    const rejectedOwner = privateDownload(
      relay,
      [event(1).id],
      () => false,
      downloadOptions,
    ).subscribe((e) => rejectedValues.push(e));
    const accepted = result(
      privateDownload(other, [event(1).id], accepts, downloadOptions),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    cached.push(event(1));
    arrivals.next(event(1));
    expect(await accepted).toEqual([event(1)]);
    expect(publicValues).toEqual([]);
    expect(rejectedValues).toEqual([]);
    expect(publicOwner.closed || rejectedOwner.closed).toBe(false);
    expect(receipt).not.toHaveBeenCalled();
    publicOwner.unsubscribe();
    rejectedOwner.unsubscribe();
    expect(arrivals.observed).toBe(false);
  });

  it("fulfills a cached body during admission cooldown without another network attempt", async () => {
    vi.useFakeTimers();
    try {
      const cached: NostrEvent[] = [];
      const arrivals = new Subject<NostrEvent>();
      const request = vi.fn(() =>
        throwError(() => new HistoryAdmissionError(Date.now() + 65_000)),
      );
      const receipt = vi.fn();
      const download = createMissingEventDownloads(
        () => cached,
        request,
        receipt,
        arrivals,
      );
      let completed = false;
      const pending = firstValueFrom(
        download(relay, [event(1).id], accepts, downloadOptions).pipe(
          toArray(),
        ),
      ).then((events) => {
        completed = true;
        return events;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      expect(completed).toBe(false);
      cached.push(event(1));
      arrivals.next(event(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(true);
      expect(await pending).toEqual([event(1)]);
      expect(arrivals.observed).toBe(false);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(request).toHaveBeenCalledTimes(1);
      expect(receipt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes notified owners while read-only adapters retain the inactivity fallback", async () => {
    vi.useFakeTimers();
    try {
      const cached: NostrEvent[] = [];
      const request = vi.fn(() => NEVER);
      const receipt = vi.fn();
      const download = createMissingEventDownloads(
        () => cached,
        request,
        receipt,
      );
      const arrivals = new Subject<NostrEvent>();
      const notified = createMissingEventDownloads(
        () => cached,
        request,
        receipt,
        arrivals,
      );
      let notifiedComplete = false;
      const notifiedResult = firstValueFrom(
        notified(relay, [event(1).id], accepts, downloadOptions).pipe(
          toArray(),
        ),
      ).then((events) => {
        notifiedComplete = true;
        return events;
      });
      let completed = false;
      const result = firstValueFrom(
        download(relay, [event(1).id], accepts, downloadOptions).pipe(
          toArray(),
        ),
      ).then((events) => {
        completed = true;
        return events;
      });
      await vi.advanceTimersByTimeAsync(0);
      cached.push(event(1));
      arrivals.next(event(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(notifiedComplete).toBe(true);
      expect(await notifiedResult).toEqual([event(1)]);
      expect(arrivals.observed).toBe(false);
      // Both received the same body at the same instant. Only the read-only
      // adapter must wait for the existing 15-second inactivity deadline.
      await vi.advanceTimersByTimeAsync(14_999);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual([event(1)]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(receipt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries capped partial responses and reuses store arrivals after admission waits", async () => {
    const bodies = [event(1), event(2), event(3)];
    const request = vi.fn((_source: string, filters: Filter[]) =>
      of(...bodies.filter((e) => filters[0].ids?.includes(e.id)).slice(0, 1)),
    );
    const download = createMissingEventDownloads(
      () => [],
      request,
      () => undefined,
    );
    expect(
      await result(
        download(
          relay,
          bodies.map((e) => e.id),
          accepts,
          downloadOptions,
        ),
      ),
    ).toEqual(bodies);
    expect(request).toHaveBeenCalledTimes(3);

    vi.useFakeTimers();
    try {
      let cached: NostrEvent[] = [];
      const paused = vi.fn(() => {
        cached = [event(1)];
        return throwError(() => new HistoryAdmissionError(Date.now() + 100));
      });
      const retry = createMissingEventDownloads(
        () => cached,
        paused,
        () => undefined,
      );
      const output = firstValueFrom(
        retry(relay, [event(1).id], accepts, downloadOptions).pipe(toArray()),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(await output).toEqual(cached);
      expect(paused).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prioritizes queued consumers and promotes aged background work", async () => {
    vi.useFakeTimers();
    const subscriptions: { unsubscribe: () => void }[] = [];
    try {
      const responses: Subject<NostrEvent>[] = [];
      const request = vi.fn((_relay: string, _filters: Filter[]) => {
        const response = new Subject<NostrEvent>();
        responses.push(response);
        return response;
      });
      const download = createMissingEventDownloads(
        () => [],
        request,
        () => undefined,
      );
      subscriptions.push(
        download(relay, [event(1).id], accepts, {
          limit: 1,
          priority: 3,
        }).subscribe(),
      );
      await vi.advanceTimersByTimeAsync(0);
      for (const [id, priority] of [
        [2, 3],
        [3, 1],
        [4, 2],
        [5, 0],
      ]) {
        subscriptions.push(
          download(relay, [event(id).id], accepts, {
            limit: 1,
            priority,
          }).subscribe(),
        );
      }
      responses[0].next(event(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls[1][1]).toEqual([{ ids: [event(5).id] }]);
      await vi.advanceTimersByTimeAsync(5_000);
      responses[1].next(event(5));
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls[2][1]).toEqual([{ ids: [event(2).id] }]);
    } finally {
      subscriptions.forEach((sub) => sub.unsubscribe());
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("does not share across store/privacy scopes or accept a body outside a consumer's filter", async () => {
    const request = vi.fn(() => of(event(1)));
    const a = createMissingEventDownloads(
      () => [],
      request,
      () => undefined,
    );
    const b = createMissingEventDownloads(
      () => [],
      request,
      () => undefined,
    );
    await Promise.all([
      result(a(relay, [event(1).id], accepts, downloadOptions)),
      result(b(relay, [event(1).id], accepts, downloadOptions)),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    const valid = result(a(relay, [event(1).id], accepts, downloadOptions));
    const invalid = result(
      a(other, [event(1).id], () => false, downloadOptions),
    );
    const rejected = expect(invalid).rejects.toBeInstanceOf(
      MissingEventDownloadError,
    );
    expect(await valid).toEqual([event(1)]);
    await rejected;
  });
});
