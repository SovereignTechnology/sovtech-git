import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BehaviorSubject,
  firstValueFrom,
  of,
  throwError,
  timeout,
  toArray,
} from "rxjs";
import type { NostrEvent } from "nostr-tools";
import type { NostrRequest } from "applesauce-loaders";
import type { TimelineStatus } from "applesauce-loaders/loaders";
import type { Filter } from "applesauce-core/helpers";
import { RelayClosedError, type RelayPool } from "applesauce-relay";
import { historyWindow } from "./historyWindow";
import {
  isHistoryTerminalError,
  resilientHistoryRequest,
} from "./resilientSubscription";

function event(i: number, time: number): NostrEvent {
  return {
    id: i.toString(16).padStart(64, "0"),
    pubkey: "1".repeat(64),
    kind: 1111,
    created_at: time,
    tags: [],
    content: "",
    sig: "0".repeat(128),
  };
}
function capped(events: NostrEvent[], requests: Filter[][]): NostrRequest {
  return (_relays, filters) => {
    requests.push(filters);
    const f = filters[0];
    return of(
      ...events
        .filter(
          (e) =>
            (f.until === undefined || e.created_at <= f.until) &&
            (f.since === undefined || e.created_at >= f.since),
        )
        .slice(0, 2),
    );
  };
}
const settings = {
  limit: 5,
  until: 120,
  isTerminalError: isHistoryTerminalError,
};

describe("v7 historical coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drains smaller relay caps, retains scalar filters and deduplicates boundary overlap", async () => {
    const events = [110, 100, 90, 80, 70, 60].map((time, i) =>
      event(i + 1, time),
    );
    const requests: Filter[][] = [];
    const complete = vi.fn();
    const actual = await firstValueFrom(
      historyWindow(
        capped(events, requests),
        "wss://window.test",
        [{ kinds: [1111], search: "term" } as Filter],
        { ...settings, onComplete: complete },
      ).pipe(toArray(), timeout(1000)),
    );
    expect(actual.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(requests.length).toBeGreaterThan(2);
    expect(requests.every((filters) => filters[0].search === "term")).toBe(
      true,
    );
    expect(complete).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not hang on empty or duplicated filter sets", async () => {
    const complete = vi.fn();
    const empty = await firstValueFrom(
      historyWindow(() => of(), "wss://empty.test", [], {
        ...settings,
        onComplete: complete,
      }).pipe(toArray(), timeout(1000)),
    );
    expect(empty).toEqual([]);
    expect(complete).toHaveBeenCalledExactlyOnceWith(true);
    const request = vi.fn(() => of());
    await firstValueFrom(
      historyWindow(
        request,
        "wss://duplicate.test",
        [{ kinds: [1111] }, { kinds: [1111] }],
        settings,
      ).pipe(toArray(), timeout(1000)),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains uncertainty when a one-event source might cap a timestamp", async () => {
    const complete = vi.fn();
    const result = await firstValueFrom(
      historyWindow(
        capped([event(1, 100)], []),
        "wss://uncertain.test",
        [{ kinds: [1111] }],
        { ...settings, onComplete: complete },
      ).pipe(toArray(), timeout(1000)),
    );
    expect(result).toHaveLength(1);
    expect(complete).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("reports a saturated timestamp as incomplete, not successful exhaustion", async () => {
    const statuses: TimelineStatus[] = [];
    const complete = vi.fn();
    const actual = await firstValueFrom(
      historyWindow(
        capped(
          [1, 2, 3, 4, 5].map((i) => event(i, 100)),
          [],
        ),
        "wss://boundary.test",
        [{ kinds: [1111] }],
        {
          ...settings,
          onStatus: (s) => statuses.push(s),
          onComplete: complete,
        },
      ).pipe(toArray(), timeout(1000)),
    );
    expect(actual).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({
      state: "incomplete",
      reason: "boundary",
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("terminates policy refusal without marking an empty range covered", async () => {
    const complete = vi.fn();
    const statuses: TimelineStatus[] = [];
    await firstValueFrom(
      historyWindow(
        () => throwError(() => new RelayClosedError("blocked: policy")),
        "wss://blocked.test",
        [{ kinds: [1111] }],
        {
          ...settings,
          onStatus: (s) => statuses.push(s),
          onComplete: complete,
        },
      ).pipe(toArray(), timeout(1000)),
    );
    expect(statuses.at(-1)).toMatchObject({
      state: "incomplete",
      reason: "request",
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("survives a 65-second rate pause and retries without false coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    let fail = true;
    const requests: Filter[][] = [];
    const request = vi.fn((filters: Filter[]) =>
      fail
        ? throwError(
            () => new RelayClosedError("rate-limited: too many queries"),
          )
        : capped([event(1, 110), event(2, 100)], requests)([], filters),
    );
    const pool = {
      relay: () => ({ error$: new BehaviorSubject<unknown>(null), request }),
    } as unknown as RelayPool;
    const complete = vi.fn();
    const statuses: TimelineStatus[] = [];
    const sub = historyWindow(
      (_relays, filters) =>
        resilientHistoryRequest(pool, "wss://window-cooldown.test", filters),
      "wss://window-cooldown.test",
      [{ kinds: [1111] }],
      { ...settings, onStatus: (s) => statuses.push(s), onComplete: complete },
    ).subscribe();
    await vi.advanceTimersByTimeAsync(64_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.state).toBe("incomplete");
    fail = false;
    // Retry backoff can defer recovery beyond the earliest admission deadline.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(complete).toHaveBeenCalledExactlyOnceWith(true);
    expect(sub.closed).toBe(true);
  });

  it("cancels recovery work without committing coverage", async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => throwError(() => new Error("offline")));
    const complete = vi.fn();
    const sub = historyWindow(
      request,
      "wss://cancel-window.test",
      [{ kinds: [1111] }],
      { ...settings, onComplete: complete },
    ).subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
