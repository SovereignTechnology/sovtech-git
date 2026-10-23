import { describe, expect, it, vi } from "vitest";
import {
  Observable,
  Subject,
  firstValueFrom,
  of,
  throwError,
  timeout,
} from "rxjs";
import type { Filter } from "applesauce-core/helpers";
import type { NostrRequest } from "applesauce-loaders";
import type { NostrEvent } from "nostr-tools";
import {
  batchHistory,
  type HistoryBatch,
  type HistoryBatchResult,
} from "./batchHistory";

function event(id: number, created_at: number, kind = 1): NostrEvent {
  return {
    id: id.toString(16).padStart(64, "0"),
    created_at,
    kind,
    pubkey: "1".repeat(64),
    tags: [],
    content: "",
    sig: "0".repeat(128),
  };
}
function harness(
  request: NostrRequest,
  filters: Filter[] = [{ kinds: [1], search: "term" }],
) {
  const triggers = new Subject<HistoryBatch>();
  const results = new Subject<HistoryBatchResult>();
  const events: NostrEvent[] = [];
  const sub = triggers
    .pipe(
      batchHistory(request, "wss://batch.test", filters, {
        retryCount: 0,
        onBatchComplete: (r) => results.next(r),
      }),
    )
    .subscribe((e) => events.push(e));
  return {
    events,
    sub,
    triggers,
    async more(limit = 5) {
      const done = firstValueFrom(results.pipe(timeout(1000)));
      triggers.next({ limit, until: 120 });
      return done;
    },
  };
}
function relay(events: NostrEvent[], requests: Filter[][]): NostrRequest {
  return (_urls, filters) => {
    requests.push(filters);
    const f = filters[0];
    return of(
      ...events
        .filter(
          (e) =>
            f.kinds?.includes(e.kind) &&
            e.created_at <= f.until! &&
            (f.since === undefined || e.created_at >= f.since),
        )
        .slice(0, Math.min(f.limit!, 2)),
    );
  };
}

describe("explicit batches using v7 coverage", () => {
  it("waits for triggers, preserves search, overlaps boundaries and eventually proves exhaustion", async () => {
    const input = [110, 100, 90, 80, 70, 60].map((t, i) => event(i + 1, t));
    const requests: Filter[][] = [];
    const h = harness(relay(input, requests));
    try {
      expect(requests).toHaveLength(0);
      expect((await h.more()).exhausted).toBe(false);
      expect(h.events).toHaveLength(2);
      expect(requests).toHaveLength(1);
      expect((await h.more()).exhausted).toBe(false);
      expect(h.events).toHaveLength(3);
      let result: HistoryBatchResult | undefined;
      for (let i = 0; i < 10 && !result?.exhausted; i++)
        result = await h.more();
      expect(result?.exhausted).toBe(true);
      expect(h.events.map((e) => e.id)).toEqual(input.map((e) => e.id));
      expect(requests.every(([f]) => f.search === "term")).toBe(true);
      const count = requests.length;
      await h.more();
      expect(requests).toHaveLength(count);
    } finally {
      h.sub.unsubscribe();
    }
  });

  it("keeps independent cursors for sparse and dense filters and accepts changed limits", async () => {
    const requests: Filter[][] = [];
    const h = harness(
      relay(
        [event(1, 110), event(2, 100), event(3, 90), event(4, 10, 2)],
        requests,
      ),
      [{ kinds: [1] }, { kinds: [2] }],
    );
    try {
      await h.more(10);
      await h.more(200);
      expect(
        requests.filter(([f]) => f.kinds?.[0] === 1).map(([f]) => f.until),
      ).toEqual([120, 100]);
      expect(requests.some(([f]) => f.limit === 200)).toBe(true);
      expect(h.events.some((e) => e.created_at === 90)).toBe(true);
    } finally {
      h.sub.unsubscribe();
    }
  });

  it("settles failures without advancing a cursor and retries only on another trigger", async () => {
    let fail = true;
    const requests: Filter[][] = [];
    const h = harness((urls, filters) => {
      if (fail) {
        requests.push(filters);
        return throwError(() => new Error("offline"));
      }
      return relay([event(1, 110), event(2, 100)], requests)(urls, filters);
    });
    try {
      expect(await h.more()).toMatchObject({
        incomplete: true,
        exhausted: false,
      });
      expect(requests).toHaveLength(1);
      fail = false;
      expect(await h.more()).toMatchObject({
        incomplete: false,
        exhausted: false,
      });
      expect(requests.map(([f]) => f.until)).toEqual([120, 120]);
    } finally {
      h.sub.unsubscribe();
    }
  });

  it("does not label a saturated timestamp exhausted or skip it", async () => {
    const requests: Filter[][] = [];
    const h = harness(
      relay(
        [event(1, 100), event(2, 100), event(3, 100), event(4, 90)],
        requests,
      ),
    );
    try {
      await h.more();
      expect(await h.more()).toMatchObject({
        incomplete: true,
        exhausted: false,
      });
      expect(h.events).toHaveLength(2);
      expect(requests.every(([f]) => f.until! >= 100)).toBe(true);
    } finally {
      h.sub.unsubscribe();
    }
  });

  it("ignores overlapping triggers and tears down in-flight requests", async () => {
    let closed = false;
    const h = harness(
      () =>
        new Observable<NostrEvent>(() => () => {
          closed = true;
        }),
    );
    h.triggers.next({ limit: 5, until: 120 });
    // Drain the v7 scheduler's microtask, not an arbitrary wall-clock sleep.
    await Promise.resolve();
    h.triggers.next({ limit: 200, until: 120 });
    h.sub.unsubscribe();
    expect(closed).toBe(true);
  });
});

it("retries only the current batch through admission cooldowns", async () => {
  vi.useFakeTimers();
  const triggers = new Subject<HistoryBatch>();
  const complete = vi.fn();
  let admitted = false;
  let attempts = 0;
  const requests: Filter[][] = [];
  const admission = new Error("local cooldown");
  const sub = triggers
    .pipe(
      batchHistory(
        (_urls, filters) => {
          attempts++;
          if (!admitted) return throwError(() => admission);
          requests.push(filters);
          return of(event(1, 110), event(2, 100));
        },
        "wss://cooldown-batch.test",
        [{ kinds: [1] }],
        {
          retryCount: 0,
          isAdmissionError: (error) => error === admission,
          onBatchComplete: complete,
        },
      ),
    )
    .subscribe();
  try {
    triggers.next({ limit: 20, until: 120 });
    await vi.advanceTimersByTimeAsync(64_000);
    expect(attempts).toBeGreaterThan(1);
    expect(requests).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    admitted = true;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(requests).toHaveLength(1);
    expect(requests[0][0].until).toBe(120);
    expect(complete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(requests).toHaveLength(1);
  } finally {
    sub.unsubscribe();
    vi.useRealTimers();
  }
});

it("does not advance to a partial failed attempt's oldest event after recovery", async () => {
  vi.useFakeTimers();
  const triggers = new Subject<HistoryBatch>();
  const complete = vi.fn();
  const requests: Filter[][] = [];
  const sub = triggers
    .pipe(
      batchHistory(
        (_urls, filters) => {
          requests.push(filters);
          if (requests.length === 1)
            return new Observable<NostrEvent>((subscriber) => {
              subscriber.next(event(1, 10));
              subscriber.error(new Error("connection lost before EOSE"));
            });
          return of(event(2, 110), event(3, 100));
        },
        "wss://partial-batch.test",
        [{ kinds: [1] }],
        { onBatchComplete: complete },
      ),
    )
    .subscribe();
  try {
    triggers.next({ limit: 20, until: 120 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(complete).toHaveBeenCalledOnce();
    triggers.next({ limit: 20, until: 120 });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[2][0].until).toBe(100);
  } finally {
    sub.unsubscribe();
    vi.useRealTimers();
  }
});

it("does not mistake a reduced batch limit for proof of boundary exhaustion", async () => {
  const events = [
    event(1, 110),
    event(2, 100),
    event(3, 100),
    event(4, 100),
    event(5, 90),
  ];
  const h = harness((_urls, filters) => {
    const f = filters[0];
    return of(
      ...events.filter((e) => e.created_at <= f.until!).slice(0, f.limit),
    );
  });
  try {
    await h.more(3);
    expect(await h.more(1)).toMatchObject({
      incomplete: true,
      exhausted: false,
    });
    expect(h.events.some((e) => e.created_at === 90)).toBe(false);
  } finally {
    h.sub.unsubscribe();
  }
});
