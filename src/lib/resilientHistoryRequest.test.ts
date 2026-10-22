import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayClosedError, type RelayPool } from "applesauce-relay";
import {
  BehaviorSubject,
  EMPTY,
  NEVER,
  throwError,
  type Subscription,
} from "rxjs";
import {
  HistoryAdmissionError,
  getRateLimitCooldownRemaining,
  markRateLimited,
  resilientHistoryRequest,
} from "./resilientSubscription";

function fixture(request = vi.fn(() => EMPTY)) {
  const relay = { error$: new BehaviorSubject<unknown>(null), request };
  return { request, pool: { relay: () => relay } as unknown as RelayPool };
}

describe("history relay admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("paces background starts and cancels queued work", async () => {
    const { pool, request } = fixture();
    const first = resilientHistoryRequest(pool, "wss://paced.test", [
      {},
    ]).subscribe();
    const cancelled = resilientHistoryRequest(pool, "wss://paced.test", [
      {},
    ]).subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    cancelled.unsubscribe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    first.unsubscribe();
  });

  it("preserves a refusal and rechecks shared cooldown after pacing", async () => {
    const { pool, request } = fixture();
    const errors: unknown[] = [];
    resilientHistoryRequest(pool, "wss://cooldown-history.test", [
      {},
    ]).subscribe();
    resilientHistoryRequest(pool, "wss://cooldown-history.test", [
      {},
    ]).subscribe({ error: (e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(0);
    markRateLimited("wss://cooldown-history.test", Date.now() + 65_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(errors[0]).toBeInstanceOf(HistoryAdmissionError);
  });

  it("backs off past the minute window, doubles a failed recovery, and never completes on failure", async () => {
    const refusal = new RelayClosedError("rate-limited: too many queries");
    const request = vi.fn(() => throwError(() => refusal));
    const { pool } = fixture(request);
    const errors: unknown[] = [];
    const complete = vi.fn();
    const attempt = () =>
      resilientHistoryRequest(pool, "wss://refusal-history.test", [
        {},
      ]).subscribe({ error: (e) => errors.push(e), complete });
    attempt();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0]).toBe(refusal);
    expect(getRateLimitCooldownRemaining("wss://refusal-history.test")).toBe(
      65_000,
    );
    attempt();
    expect(errors[1]).toBeInstanceOf(HistoryAdmissionError);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(65_000);
    attempt();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(getRateLimitCooldownRemaining("wss://refusal-history.test")).toBe(
      130_000,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("limits active pages and releases capacity on cancellation", async () => {
    const { pool, request } = fixture(vi.fn(() => NEVER));
    const subscriptions: Subscription[] = [];
    for (let i = 0; i < 5; i++) {
      subscriptions.push(
        resilientHistoryRequest(pool, "wss://capacity-history.test", [
          {},
        ]).subscribe(),
      );
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const errors: unknown[] = [];
    resilientHistoryRequest(pool, "wss://capacity-history.test", [
      {},
    ]).subscribe({ error: (e) => errors.push(e) });
    expect(request).toHaveBeenCalledTimes(5);
    expect(errors[0]).toBeInstanceOf(HistoryAdmissionError);
    subscriptions[0].unsubscribe();
    const next = resilientHistoryRequest(pool, "wss://capacity-history.test", [
      {},
    ]).subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(6);
    next.unsubscribe();
    subscriptions.forEach((s) => s.unsubscribe());
  });
});
