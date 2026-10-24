import { expect, it, vi } from "vitest";
import { RelayPool } from "applesauce-relay";
import { EMPTY, firstValueFrom, toArray } from "rxjs";
import {
  configureRelayHistory,
  historyLiveFilter,
  loadRelayHistory,
} from "./relayHistory";
it("uses a bounded live cursor only when a separate public history owner has inventory", async () => {
  const pool = new RelayPool();
  const load = vi.fn(() => EMPTY);
  configureRelayHistory(pool, {
    enabled: (relay) => relay !== "wss://private.test",
    hasInventory: (filter) => filter.kinds?.includes(1621) === true,
    load,
  });
  const filter = { kinds: [1621], "#a": ["repo"] };
  expect(historyLiveFilter(pool, "wss://public.test", filter)).toEqual({
    ...filter,
    since: expect.any(Number),
  });
  expect(filter).not.toHaveProperty("since");
  expect(historyLiveFilter(pool, "wss://private.test", filter)).toBe(filter);
  const cold = { kinds: [1111] };
  expect(historyLiveFilter(pool, "wss://public.test", cold)).toBe(cold);
  const bounded = { ...filter, since: 100 };
  expect(historyLiveFilter(pool, "wss://public.test", bounded)).toBe(bounded);
  const request = vi.fn(() => EMPTY);
  const opts = { limit: 10, isTerminalError: () => true };
  await firstValueFrom(
    loadRelayHistory(pool, request, "wss://private.test", [filter], opts).pipe(
      toArray(),
    ),
  );
  expect(request).toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  pool.close();
});
