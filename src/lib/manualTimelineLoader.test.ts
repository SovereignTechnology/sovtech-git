import { describe, expect, it } from "vitest";
import {
  BehaviorSubject,
  firstValueFrom,
  filter,
  of,
  throwError,
  timeout,
} from "rxjs";
import { RelayClosedError, type RelayPool } from "applesauce-relay";
import { EventStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { createManualTimelineLoader } from "./manualTimelineLoader";

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

it("keeps archive decisions per filter and reopens history for late relays", async () => {
  const urls = new BehaviorSubject(["wss://notification-a.test"]);
  const requests: { url: string; filters: Filter[] }[] = [];
  const events = [event(1, 110), event(2, 100), event(3, 90), event(4, 10, 2)];
  const pool = {
    relay: (url: string) => ({
      error$: new BehaviorSubject<unknown>(null),
      request: (filters: Filter[]) => {
        requests.push({ url, filters });
        const f = filters[0];
        return of(
          ...events
            .filter(
              (e) => f.kinds?.includes(e.kind) && e.created_at <= f.until!,
            )
            .slice(0, 2),
        );
      },
    }),
  } as unknown as RelayPool;
  const store = new EventStore();
  let cutoff = 50;
  const loader = createManualTimelineLoader(
    pool,
    urls,
    [{ kinds: [1] }, { kinds: [2] }],
    { eventStore: store, getArchiveCutoff: () => cutoff },
  );
  try {
    expect(requests).toHaveLength(0);
    loader.loadMore(200);
    await firstValueFrom(
      loader.historyLoading$.pipe(
        filter((loading) => !loading),
        timeout(4000),
      ),
    );
    expect(loader.historyReachedArchive$.value).toBe(false);
    expect(loader.historyHasMore$.value).toBe(true);
    cutoff = 105;
    loader.recheckArchiveCutoff();
    expect(loader.historyReachedArchive$.value).toBe(true);
    urls.next([...urls.value, "wss://notification-b.test"]);
    expect(loader.historyReachedArchive$.value).toBe(false);
    expect(requests.every((r) => r.url === "wss://notification-a.test")).toBe(
      true,
    );
    cutoff = 5;
    loader.recheckArchiveCutoff();
    expect(loader.historyReachedArchive$.value).toBe(false);
  } finally {
    loader.destroy();
    store.dispose();
  }
});

describe("notification request outcomes", () => {
  it("keeps load-more available after a failed empty batch", async () => {
    const store = new EventStore();
    const pool = {
      relay: () => ({
        error$: new BehaviorSubject<unknown>(null),
        request: () =>
          throwError(() => new RelayClosedError("blocked: policy")),
      }),
    } as unknown as RelayPool;
    const loader = createManualTimelineLoader(
      pool,
      ["wss://notification-failed.test"],
      [{ kinds: [1] }],
      { eventStore: store, getArchiveCutoff: () => 100 },
    );
    try {
      loader.loadMore(200);
      await firstValueFrom(
        loader.historyLoading$.pipe(
          filter((loading) => !loading),
          timeout(1000),
        ),
      );
      expect(loader.historyHasMore$.value).toBe(true);
      expect(loader.historyReachedArchive$.value).toBe(false);
    } finally {
      loader.destroy();
      store.dispose();
    }
  });
});
