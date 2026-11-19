/**
 * End-to-end tests for resilientAdditiveSubscription.
 *
 * Uses vitest-websocket-mock (WS) like resilientSubscription.test.ts so the
 * full applesauce relay stack (RelayPool → Relay → WebSocket) runs
 * unmodified against the actual relay protocol. See that file's header for
 * the timer strategy, retry-triggering patterns, and mock-server caveats.
 *
 * Waits are bounded: protocol frames via nextReq (raced against a deadline),
 * emitted values via vi.waitFor. The synchronous-failure test uses fake
 * timers — it never touches the WebSocket mock, so the interaction warned
 * about in resilientSubscription.test.ts does not apply.
 */

import { Relay, RelayPool } from "applesauce-relay";
import { matchFilter, type Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import {
  BehaviorSubject,
  Subject,
  concat,
  of,
  throwError,
  type Subscription,
} from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";

import {
  AdditiveFilterConflictError,
  getRateLimitCooldownRemaining,
  resilientAdditiveSubscription,
  type AdditiveFilterChunk,
  type ResilientAdditiveSubscriptionOptions,
  type ResilientSubscriptionResponse,
} from "@/lib/resilientSubscription";

const RELAY_URL = "wss://additive-one.test";
const RELAY_URL_2 = "wss://additive-two.test";

const mockEvent: NostrEvent = {
  kind: 1,
  id: "aa".repeat(32),
  pubkey: "bb".repeat(32),
  created_at: 1_700_000_000,
  tags: [],
  content: "hello",
  sig: "cc".repeat(64),
};

const mockEvent2: NostrEvent = {
  ...mockEvent,
  id: "dd".repeat(32),
  created_at: mockEvent.created_at + 1,
};

type ReqMessage = ["REQ", string, ...Filter[]];

function requests(server: WS): ReqMessage[] {
  return server.messages.filter(
    (message): message is ReqMessage =>
      Array.isArray(message) && message[0] === "REQ",
  );
}

function closes(server: WS): Array<["CLOSE", string]> {
  return server.messages.filter(
    (message): message is ["CLOSE", string] =>
      Array.isArray(message) && message[0] === "CLOSE",
  );
}

/** Await the next REQ frame, skipping CLOSE frames, bounded by a deadline. */
async function nextReq(server: WS, timeoutMs = 1_000): Promise<ReqMessage> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error("timed out waiting for REQ")),
      timeoutMs,
    );
  });
  try {
    for (;;) {
      const message = (await Promise.race([
        server.nextMessage,
        deadline,
      ])) as unknown[];
      if (message[0] === "REQ") return message as ReqMessage;
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function chunk(key: string, filter: Filter): AdditiveFilterChunk {
  return { key, filters: [filter], deltaSafe: true };
}

function eoseCount(values: ResilientSubscriptionResponse[]): number {
  return values.filter((value) => value === "EOSE").length;
}

let server: WS;
let server2: WS;
let pool: RelayPool;

/**
 * Track a subscription so afterEach can tear it down even when an assertion
 * fails mid-test. A leaked live subscription reconnects to the next test's
 * mock server (same URL) and contaminates its frames.
 */
const trackedSubscriptions: Subscription[] = [];
function track(subscription: Subscription): Subscription {
  trackedSubscriptions.push(subscription);
  return subscription;
}

beforeEach(() => {
  vi.spyOn(Relay, "fetchInformationDocument").mockImplementation(() =>
    Promise.resolve(null),
  );

  server = new WS(RELAY_URL, { jsonProtocol: true });
  server2 = new WS(RELAY_URL_2, { jsonProtocol: true });

  pool = new RelayPool();

  // Disable keep-alive pings and the 1s+ reconnect backoff — but only once
  // per relay instance, so a test that installs its own reconnectTimer gate
  // is not clobbered by later internal pool.relay() calls.
  const origRelay = pool.relay.bind(pool);
  const tuned = new WeakSet<Relay>();
  vi.spyOn(pool, "relay").mockImplementation((url: string) => {
    const r = origRelay(url);
    if (!tuned.has(r)) {
      tuned.add(r);
      r.keepAlive = 0;
      r.reconnectTimer = () => of(0);
    }
    return r;
  });
});

afterEach(async () => {
  for (const subscription of trackedSubscriptions) subscription.unsubscribe();
  trackedSubscriptions.length = 0;
  await WS.clean();
  vi.clearAllMocks();
});

describe("resilientAdditiveSubscription", () => {
  it("consolidates initial chunks into one REQ, delivers events, settles, and tears down", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const values: ResilientSubscriptionResponse[] = [];
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      {
        initial: [
          chunk("notes", { kinds: [1] }),
          chunk("profiles", { kinds: [0] }),
        ],
        additions$: additions,
      },
      { settleTime: 1, retryDelay: 0 },
    ).subscribe((value) => values.push(value));
    track(subscription);

    const req = await nextReq(server);
    expect(req.slice(2)).toEqual([{ kinds: [1] }, { kinds: [0] }]);

    server.send(["EVENT", req[1], mockEvent]);
    server.send(["EOSE", req[1]]);
    await vi.waitFor(() => expect(values).toContain("EOSE"));
    expect(values).toContainEqual(
      expect.objectContaining({ id: mockEvent.id }),
    );

    subscription.unsubscribe();
    await expect(server).toReceiveMessage(["CLOSE", req[1]]);
  });

  it("opens one buffered delta REQ for added chunks without disturbing the initial REQ", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const values: ResilientSubscriptionResponse[] = [];
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
      { settleTime: 1, deltaBufferTime: 5, retryDelay: 0 },
    ).subscribe((value) => values.push(value));
    track(subscription);

    const initialReq = await nextReq(server);
    server.send(["EOSE", initialReq[1]]);
    await vi.waitFor(() => expect(eoseCount(values)).toBe(1));

    additions.next(chunk("profiles", { kinds: [0] }));
    additions.next(chunk("deletions", { kinds: [5] }));
    const deltaReq = await nextReq(server);

    expect(deltaReq.slice(2)).toEqual([{ kinds: [0] }, { kinds: [5] }]);
    expect(requests(server)).toHaveLength(2);
    expect(closes(server)).not.toContainEqual(["CLOSE", initialReq[1]]);

    // Settlement is monotonic: the delta stream's EOSE and events add no
    // second sentinel and never unsettle the session.
    server.send(["EOSE", deltaReq[1]]);
    server.send(["EVENT", deltaReq[1], mockEvent2]);
    await vi.waitFor(() =>
      expect(values).toContainEqual(
        expect.objectContaining({ id: mockEvent2.id }),
      ),
    );
    expect(eoseCount(values)).toBe(1);

    subscription.unsubscribe();
  });

  it("settles on initial-plan EOSE even while a delta REQ is still pending", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const values: ResilientSubscriptionResponse[] = [];
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
      { settleTime: 1, deltaBufferTime: 1, retryDelay: 0 },
    ).subscribe((value) => values.push(value));
    track(subscription);

    const initialReq = await nextReq(server);
    additions.next(chunk("profiles", { kinds: [0] }));
    await nextReq(server); // delta REQ opened, never answered

    server.send(["EOSE", initialReq[1]]);
    await vi.waitFor(() => expect(values).toContain("EOSE"));

    subscription.unsubscribe();
  });

  it("reconnects with the full chunk set plus since gap-fill and closes delta REQs", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
      {
        settleTime: 1,
        deltaBufferTime: 1,
        retryDelay: 0,
        retryCount: Infinity,
        gapFillBuffer: 600,
      },
    ).subscribe();
    track(subscription);

    const initialReq = await nextReq(server);
    server.send(["EVENT", initialReq[1], mockEvent]);
    server.send(["EOSE", initialReq[1]]);

    additions.next(chunk("profiles", { kinds: [0] }));
    const deltaReq = await nextReq(server);
    expect(deltaReq.slice(2)).toEqual([{ kinds: [0] }]);

    // Transient CLOSED on the main REQ → the reconnect REQ re-reads the full
    // chunk set with since gap-fill, and the delta REQ is consolidated away.
    server.send(["CLOSED", initialReq[1], "error: temporary outage"]);
    const reconnectReq = await nextReq(server);
    expect(reconnectReq.slice(2)).toEqual([
      { kinds: [1], since: mockEvent.created_at - 600 },
      { kinds: [0], since: mockEvent.created_at - 600 },
    ]);
    await vi.waitFor(() =>
      expect(closes(server)).toContainEqual(["CLOSE", deltaReq[1]]),
    );

    subscription.unsubscribe();
  });

  it("sends delta REQs only to connected relays and consolidates on reconnect", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const values: ResilientSubscriptionResponse[] = [];
    const subscription = track(
      resilientAdditiveSubscription(
        pool,
        [RELAY_URL, RELAY_URL_2],
        { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
        {
          settleTime: 1,
          deltaBufferTime: 1,
          retryDelay: 0,
          retryCount: Infinity,
        },
      ).subscribe((value) => values.push(value)),
    );

    const req1 = await nextReq(server);
    const req2 = await nextReq(server2);
    server.send(["EOSE", req1[1]]);
    server2.send(["EOSE", req2[1]]);
    await vi.waitFor(() => expect(eoseCount(values)).toBe(1));

    // Mark relay 2's shared transport as failed. The mock server cannot
    // accept a second WebSocket connection, so (like the archive tests) the
    // failure is injected via the relay's public error$/open$ subjects while
    // the underlying socket stays alive.
    const relay2 = pool.relay(RELAY_URL_2);
    relay2.error$.next(new Error("network lost"));

    additions.next(chunk("profiles", { kinds: [0] }));
    const deltaReq = await nextReq(server);
    expect(deltaReq.slice(2)).toEqual([{ kinds: [0] }]);
    // The failed relay received no delta REQ.
    expect(requests(server2)).toHaveLength(1);

    // Recovery: the reconnect REQ carries the full current chunk set.
    relay2.error$.next(null);
    relay2.open$.next(new Event("open"));
    const consolidatedReq = await nextReq(server2);
    expect(consolidatedReq.slice(2)).toEqual([{ kinds: [1] }, { kinds: [0] }]);
    expect(requests(server2)).toHaveLength(2);
    // Settlement never fired a second sentinel across the drop and recovery.
    expect(eoseCount(values)).toBe(1);

    subscription.unsubscribe();
  });

  it("gives a newly joined relay the full chunk set and closes a removed relay alone", async () => {
    const relays = new BehaviorSubject<string[]>([RELAY_URL]);
    const additions = new Subject<AdditiveFilterChunk>();
    const subscription = resilientAdditiveSubscription(
      pool,
      relays,
      { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
      { settleTime: 1, deltaBufferTime: 1, retryDelay: 0 },
    ).subscribe();
    track(subscription);

    const initialReq = await nextReq(server);
    additions.next(chunk("profiles", { kinds: [0] }));
    const deltaReq = await nextReq(server);

    relays.next([RELAY_URL, RELAY_URL_2]);
    const joinedReq = await nextReq(server2);
    expect(joinedReq.slice(2)).toEqual([{ kinds: [1] }, { kinds: [0] }]);
    // The existing relay's REQs were not disturbed by the join.
    expect(requests(server)).toHaveLength(2);
    expect(closes(server)).toHaveLength(0);

    relays.next([RELAY_URL_2]);
    await vi.waitFor(() => {
      const closedIds = closes(server).map((message) => message[1]);
      expect(closedIds).toEqual(
        expect.arrayContaining([initialReq[1], deltaReq[1]]),
      );
    });
    expect(closes(server2)).toHaveLength(0);

    subscription.unsubscribe();
  });

  it("closes every REQ on teardown and ignores later additions", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
      { settleTime: 1, deltaBufferTime: 1, retryDelay: 0 },
    ).subscribe();
    track(subscription);

    const initialReq = await nextReq(server);
    additions.next(chunk("profiles", { kinds: [0] }));
    const deltaReq = await nextReq(server);

    subscription.unsubscribe();
    additions.next(chunk("deletions", { kinds: [5] }));
    await vi.waitFor(() => {
      const closedIds = closes(server).map((message) => message[1]);
      expect(closedIds).toEqual(
        expect.arrayContaining([initialReq[1], deltaReq[1]]),
      );
    });
    // The post-teardown addition opened nothing.
    expect(requests(server)).toHaveLength(2);
  });

  it("splits addition bursts at deltaBufferSize", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
      { settleTime: 1, deltaBufferTime: 60_000, deltaBufferSize: 2 },
    ).subscribe();
    track(subscription);

    await nextReq(server);
    additions.next(chunk("zero", { kinds: [0] }));
    additions.next(chunk("five", { kinds: [5] }));
    const firstDelta = await nextReq(server);
    additions.next(chunk("six", { kinds: [6] }));
    additions.next(chunk("seven", { kinds: [7] }));
    const secondDelta = await nextReq(server);

    expect(firstDelta.slice(2)).toEqual([{ kinds: [0] }, { kinds: [5] }]);
    expect(secondDelta.slice(2)).toEqual([{ kinds: [6] }, { kinds: [7] }]);

    subscription.unsubscribe();
  });

  it("supports an empty initial plan: settles immediately, first addition opens the REQ", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const values: ResilientSubscriptionResponse[] = [];
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      { initial: [], additions$: additions },
      { settleTime: 1, deltaBufferTime: 1 },
    ).subscribe((value) => values.push(value));
    track(subscription);

    await vi.waitFor(() => expect(values).toContain("EOSE"));
    expect(server.messages).toHaveLength(0);

    additions.next(chunk("notes", { kinds: [1] }));
    const req = await nextReq(server);
    expect(req.slice(2)).toEqual([{ kinds: [1] }]);

    subscription.unsubscribe();
  });

  it("suppresses canonical duplicates and rejects conflicting key reuse", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const errors: unknown[] = [];
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      {
        initial: [
          {
            key: "identity",
            filters: [
              { authors: ["beta", "alpha"], kinds: [1, 0] },
              { "#p": ["two", "one"] },
            ],
          },
        ],
        additions$: additions,
      },
      { settleTime: 1, deltaBufferTime: 1 },
    ).subscribe({ error: (error) => errors.push(error) });
    track(subscription);

    await nextReq(server);
    // Canonically identical resubmission (reordered, deduplicated) — no-op.
    additions.next({
      key: "identity",
      filters: [
        { "#p": ["one", "two", "two"] },
        { kinds: [0, 1, 1], authors: ["alpha", "beta"] },
      ],
      deltaSafe: true,
    });
    additions.next(chunk("notes", { kinds: [1] }));
    const deltaReq = await nextReq(server);
    expect(deltaReq.slice(2)).toEqual([{ kinds: [1] }]);

    additions.next(chunk("identity", { kinds: [3] }));
    await vi.waitFor(() =>
      expect(errors[0]).toBeInstanceOf(AdditiveFilterConflictError),
    );
    expect(requests(server)).toHaveLength(2);

    subscription.unsubscribe();
  });

  it("rejects a late addition that is not declared deltaSafe", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const errors: unknown[] = [];
    const subscription = resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      { initial: [chunk("notes", { kinds: [1] })], additions$: additions },
      { settleTime: 1, deltaBufferTime: 1 },
    ).subscribe({ error: (error) => errors.push(error) });
    track(subscription);

    await nextReq(server);
    additions.next({ key: "profiles", filters: [{ kinds: [0] }] });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect((errors[0] as TypeError).message).toMatch(/deltaSafe/);
    expect(requests(server)).toHaveLength(1);

    subscription.unsubscribe();
  });

  it("rejects a deltaSafe declaration whose filters are not delta-safe", () => {
    for (const unsafe of [
      { kinds: [1], limit: 5 },
      { kinds: [1], since: 100 },
      { kinds: [1], until: 100 },
      { kinds: [1], search: "hello" },
      { ids: ["aabbcc"] },
    ] satisfies Filter[]) {
      const errors: unknown[] = [];
      resilientAdditiveSubscription(pool, [RELAY_URL], {
        initial: [{ key: "bad", filters: [unsafe], deltaSafe: true }],
      }).subscribe({ error: (error) => errors.push(error) });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(TypeError);
      expect((errors[0] as TypeError).message).toMatch(/deltaSafe/);
    }
    expect(server.messages).toHaveLength(0);
  });

  it("rejects pagination modes synchronously", () => {
    expect(() =>
      resilientAdditiveSubscription(
        pool,
        [RELAY_URL],
        { initial: [chunk("notes", { kinds: [1] })] },
        { paginate: true } as ResilientAdditiveSubscriptionOptions,
      ),
    ).toThrow(
      /live additive subscriptions do not support automatic pagination/,
    );

    expect(() =>
      resilientAdditiveSubscription(
        pool,
        [RELAY_URL],
        { initial: [chunk("notes", { kinds: [1] })] },
        {
          manualPaginate$: new Subject<void>(),
        } as ResilientAdditiveSubscriptionOptions,
      ),
    ).toThrow(/additive queries do not support manual pagination/);
  });

  it("tears down a synchronous additions$ failure without arming timers", () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const subscription = resilientAdditiveSubscription(pool, [RELAY_URL], {
        initial: [],
        additions$: concat(
          of(chunk("sync", { kinds: [1] })),
          throwError(() => new Error("boom")),
        ),
      }).subscribe({ error: (error) => errors.push(error) });

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("boom");
      expect(pool.relay).not.toHaveBeenCalled();

      // Nothing is left armed: advancing past every buffer and settle
      // deadline starts no relay work.
      vi.advanceTimersByTime(120_000);
      expect(pool.relay).not.toHaveBeenCalled();

      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("additive root history", () => {
  function roots(coordinate: string, offset = 0): NostrEvent[] {
    return [400, 300, 200, 100].map((time, index) => ({
      ...mockEvent,
      kind: 1621,
      id: (index + offset + 1).toString(16).padStart(64, "0"),
      created_at: 1700000000 + time,
      tags: [["a", coordinate]],
    }));
  }
  function answer(target: WS, req: ReqMessage, events: NostrEvent[]) {
    const found = new Map<string, NostrEvent>();
    for (const filter of req.slice(2) as Filter[])
      for (const event of events
        .filter((event) => matchFilter(filter, event))
        .slice(0, 2))
        found.set(event.id, event);
    for (const event of found.values()) target.send(["EVENT", req[1], event]);
    target.send(["EOSE", req[1]]);
  }
  async function drain(
    target: WS,
    events: NostrEvent[],
    complete: () => boolean,
  ) {
    while (!complete()) {
      const req = await nextReq(target, 5000);
      const handled =
        requests(target).findIndex((frame) => frame[1] === req[1]) + 1;
      answer(target, req, events);
      await vi.waitFor(
        () =>
          expect(complete() || requests(target).length > handled).toBe(true),
        { timeout: 5000 },
      );
    }
  }

  it("recovers capped roots and late coordinates while preserving live updates and initial settlement", async () => {
    const additions = new Subject<AdditiveFilterChunk>();
    const values: ResilientSubscriptionResponse[] = [];
    const complete = vi.fn();
    const a = roots("a"),
      b = roots("b", 10);
    track(
      resilientAdditiveSubscription(
        pool,
        [RELAY_URL],
        {
          initial: [chunk("a", { kinds: [1621], "#a": ["a"] })],
          additions$: additions,
        },
        {
          history: true,
          limit: 500,
          settleTime: 1,
          onHistoryComplete: complete,
        },
      ).subscribe((value) => values.push(value)),
    );
    const initial = await nextReq(server);
    answer(server, initial, a);
    await vi.waitFor(() => expect(eoseCount(values)).toBe(1));
    expect(complete).not.toHaveBeenCalled();
    await drain(server, a, () => complete.mock.calls.length === 1);
    expect(complete).toHaveBeenLastCalledWith(RELAY_URL, "a", true);
    expect(
      new Set(
        values.filter((value) => value !== "EOSE").map((value) => value.id),
      ),
    ).toEqual(new Set(a.map((event) => event.id)));
    additions.next(chunk("b", { kinds: [1621], "#a": ["b"] }));
    const delta = await nextReq(server);
    answer(server, delta, b);
    await drain(server, b, () => complete.mock.calls.length === 2);
    expect(complete).toHaveBeenLastCalledWith(RELAY_URL, "b", true);
    expect(eoseCount(values)).toBe(1);
    expect(
      new Set(
        values.filter((value) => value !== "EOSE").map((value) => value.id),
      ),
    ).toEqual(new Set([...a, ...b].map((event) => event.id)));
    const live = { ...a[0], id: "ef".repeat(32), created_at: 1700000500 };
    server.send(["EVENT", initial[1], live]);
    await vi.waitFor(() => expect(values).toContainEqual(live));
    expect(closes(server).some((frame) => frame[1] === initial[1])).toBe(false);
  }, 20000);

  it("cancels removed-relay history without completion and starts fresh for a new relay", async () => {
    const relays = new BehaviorSubject([RELAY_URL]);
    const complete = vi.fn();
    track(
      resilientAdditiveSubscription(
        pool,
        relays,
        {
          initial: [chunk("roots", { kinds: [1621] })],
        },
        { history: true, onHistoryComplete: complete },
      ).subscribe(),
    );
    const initial = await nextReq(server);
    server.send(["EOSE", initial[1]]);
    const history = await nextReq(server);
    expect(history[2]).toHaveProperty("until");
    relays.next([]);
    await vi.waitFor(() =>
      expect(closes(server).map((frame) => frame[1])).toEqual(
        expect.arrayContaining([initial[1], history[1]]),
      ),
    );
    expect(complete).not.toHaveBeenCalled();
    relays.next([RELAY_URL_2]);
    const next = await nextReq(server2);
    server2.send(["EOSE", next[1]]);
    const nextHistory = await nextReq(server2);
    server2.send(["EOSE", nextHistory[1]]);
    await vi.waitFor(() =>
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        RELAY_URL_2,
        "roots",
        true,
      ),
    );
  });

  it("does not report a rate-limited history attempt as completed", async () => {
    const url = "wss://additive-history-cooldown.test";
    const target = new WS(url, { jsonProtocol: true });
    const complete = vi.fn();
    const sub = track(
      resilientAdditiveSubscription(
        pool,
        [url],
        {
          initial: [chunk("roots", { kinds: [1621] })],
        },
        { history: true, onHistoryComplete: complete },
      ).subscribe(),
    );
    const initial = await nextReq(target);
    target.send(["EOSE", initial[1]]);
    const history = await nextReq(target);
    target.send(["CLOSED", history[1], "rate-limited: too many queries"]);
    await vi.waitFor(() =>
      expect(getRateLimitCooldownRemaining(url)).toBeGreaterThan(60000),
    );
    expect(complete).not.toHaveBeenCalled();
    sub.unsubscribe();
    expect(complete).not.toHaveBeenCalled();
  });

  it("reports terminal history refusal as incomplete without closing the live query", async () => {
    const complete = vi.fn();
    track(
      resilientAdditiveSubscription(
        pool,
        [RELAY_URL],
        {
          initial: [chunk("roots", { kinds: [1621] })],
        },
        { history: true, onHistoryComplete: complete },
      ).subscribe(),
    );
    const initial = await nextReq(server);
    server.send(["EOSE", initial[1]]);
    const history = await nextReq(server);
    server.send(["CLOSED", history[1], "blocked: history denied"]);
    await vi.waitFor(() =>
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        RELAY_URL,
        "roots",
        false,
      ),
    );
    expect(closes(server).some((frame) => frame[1] === initial[1])).toBe(false);
  });

  it("refuses request-relative initial filters when history is enabled", () => {
    const errors: unknown[] = [];
    resilientAdditiveSubscription(
      pool,
      [RELAY_URL],
      {
        initial: [{ key: "limited", filters: [{ kinds: [1621], limit: 2 }] }],
      },
      { history: true },
    ).subscribe({ error: (error) => errors.push(error) });
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/limit/);
    expect(pool.relay).not.toHaveBeenCalled();
  });
});
