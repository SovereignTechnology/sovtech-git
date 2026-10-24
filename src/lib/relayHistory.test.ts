import { expect, it, vi } from "vitest";
import { RelayPool } from "applesauce-relay";
import { EMPTY, firstValueFrom, toArray } from "rxjs";
import {
  configureRelayHistory,
  advertisesNegentropy,
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

it("keeps focused full-thread snapshots immediate even with cached history", () => {
  const pool = new RelayPool();
  configureRelayHistory(pool, {
    enabled: () => true,
    hasInventory: () => true,
    load: () => EMPTY,
  });
  for (const tag of ["#e", "#E", "#q"]) {
    const filter = { [tag]: ["root"] };
    expect(historyLiveFilter(pool, "wss://public.test", filter)).toBe(filter);
  }
  pool.close();
});

it("requires an explicit NIP-77 advertisement before suppressing warm snapshots", () => {
  const pool = new RelayPool();
  const relay = pool.relay("wss://capability.test");
  const info = vi.spyOn(relay, "information", "get");
  info.mockReturnValue(null);
  expect(advertisesNegentropy(pool, relay.url)).toBe(false);
  const metadata = {
    name: "fixture",
    description: "",
    pubkey: "",
    contact: "",
    software: "fixture",
    version: "1",
  };
  info.mockReturnValue({ ...metadata, supported_nips: [1, 11] });
  expect(advertisesNegentropy(pool, relay.url)).toBe(false);
  info.mockReturnValue({ ...metadata, supported_nips: [1, 77] });
  expect(advertisesNegentropy(pool, relay.url)).toBe(true);
  pool.close();
});
