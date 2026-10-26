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
