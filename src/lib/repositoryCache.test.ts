import { afterEach, expect, it, vi } from "vitest";
import { firstValueFrom } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import {
  loadRepositoryCache,
  observeRepositoryCacheRestore,
  REPOSITORY_CACHE_FALLBACK_MS,
} from "./repositoryCache";

const root: NostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  kind: 1621,
  created_at: 1,
  tags: [["a", "30617:owner:repo"]],
  content: "",
  sig: "c".repeat(128),
};
afterEach(() => vi.useRealTimers());
it("restores withdrawals and statuses before roots and excludes mention-only roots", async () => {
  const status = {
    ...root,
    id: "d".repeat(64),
    kind: 1632,
    tags: [["e", root.id]],
  };
  const deletion = {
    ...root,
    id: "e".repeat(64),
    kind: 5,
    tags: [["e", status.id]],
  };
  const mention = {
    ...root,
    id: "f".repeat(64),
    tags: [["a", "30617:owner:repo", "", "mention"]],
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce([root, mention])
    .mockResolvedValueOnce([status])
    .mockResolvedValueOnce([deletion]);
  expect(
    await firstValueFrom(loadRepositoryCache(["30617:owner:repo"], read)),
  ).toEqual([deletion, status, root]);
  expect(read.mock.calls[1][0][0]["#e"]).toEqual([root.id]);
});
it("does not emit partial roots after a dependency read fails", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce([root])
    .mockRejectedValueOnce(new Error("cache failed"));
  expect(
    await firstValueFrom(loadRepositoryCache(["30617:owner:repo"], read)),
  ).toEqual([]);
});
it("waits beyond three seconds for coherent cache data", async () => {
  vi.useFakeTimers();
  let release!: (events: NostrEvent[]) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<NostrEvent[]>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce([]);
  const next = vi.fn();
  const sub = observeRepositoryCacheRestore(
    ["30617:owner:repo"],
    read,
  ).subscribe(next);
  await vi.advanceTimersByTimeAsync(3500);
  expect(next).not.toHaveBeenCalled();
  release([root]);
  await vi.waitFor(() =>
    expect(next).toHaveBeenCalledWith({ state: "ready", events: [root] }),
  );
  await vi.advanceTimersByTimeAsync(REPOSITORY_CACHE_FALLBACK_MS);
  expect(next).toHaveBeenCalledTimes(1);
  sub.unsubscribe();
});

it("releases stalled discovery without discarding the eventual cache result", async () => {
  vi.useFakeTimers();
  let release!: (events: NostrEvent[]) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<NostrEvent[]>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce([]);
  const next = vi.fn();
  const sub = observeRepositoryCacheRestore(
    ["30617:owner:repo"],
    read,
  ).subscribe(next);
  await vi.advanceTimersByTimeAsync(REPOSITORY_CACHE_FALLBACK_MS);
  expect(next).toHaveBeenCalledExactlyOnceWith({ state: "fallback" });
  release([root]);
  await vi.waitFor(() =>
    expect(next).toHaveBeenLastCalledWith({ state: "ready", events: [root] }),
  );
  expect(read).toHaveBeenCalledTimes(2);
  sub.unsubscribe();
});

it("cancels a stalled recovery when its repository owner leaves", async () => {
  vi.useFakeTimers();
  let release!: (events: NostrEvent[]) => void;
  const read = vi.fn().mockImplementation(
    () =>
      new Promise<NostrEvent[]>((resolve) => {
        release = resolve;
      }),
  );
  const next = vi.fn();
  const sub = observeRepositoryCacheRestore(
    ["30617:owner:repo"],
    read,
  ).subscribe(next);
  await vi.advanceTimersByTimeAsync(REPOSITORY_CACHE_FALLBACK_MS);
  sub.unsubscribe();
  release([root]);
  await vi.advanceTimersByTimeAsync(0);
  expect(next).toHaveBeenCalledExactlyOnceWith({ state: "fallback" });
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not publish late data after navigation cancels hydration", async () => {
  let release: (events: NostrEvent[]) => void = () => {};
  const pending = new Promise<NostrEvent[]>((resolve) => {
    release = resolve;
  });
  const read = vi.fn().mockReturnValue(pending);
  const next = vi.fn();
  const sub = loadRepositoryCache(["30617:owner:repo"], read).subscribe(next);
  sub.unsubscribe();
  release([root]);
  await pending;
  expect(next).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it("restores public announcement discovery inputs but excludes private and quarantined coordinates", async () => {
  const { loadPublicRepositoryAnnouncements } =
    await import("./repositoryCache");
  const { markPrivateRepositoryCoordinate } =
    await import("@/services/privateRepositoryScope");
  const announcement = {
    ...root,
    kind: 30617,
    tags: [["d", "cache-discovery-test"]],
  };
  const privateAnnouncement = {
    ...announcement,
    id: "1".repeat(64),
    tags: [...announcement.tags, ["private", "true"]],
  };
  const quarantined = {
    ...announcement,
    id: "2".repeat(64),
    pubkey: "9".repeat(64),
  };
  markPrivateRepositoryCoordinate(
    `30617:${quarantined.pubkey}:cache-discovery-test`,
  );
  const other = {
    ...announcement,
    id: "3".repeat(64),
    tags: [["d", "other-repo"]],
  };
  const read = vi
    .fn()
    .mockResolvedValue([announcement, privateAnnouncement, quarantined, other]);
  expect(
    await firstValueFrom(
      loadPublicRepositoryAnnouncements("cache-discovery-test", read),
    ),
  ).toEqual([announcement]);
  expect(read).toHaveBeenCalledWith([
    { kinds: [30617], "#d": ["cache-discovery-test"] },
  ]);
});

it("leaves network discovery available when announcement cache reads fail", async () => {
  const { loadPublicRepositoryAnnouncements } =
    await import("./repositoryCache");
  expect(
    await firstValueFrom(
      loadPublicRepositoryAnnouncements("repo", async () => {
        throw new Error("disk unavailable");
      }),
    ),
  ).toEqual([]);
});

it("does not discard slow public announcement discovery", async () => {
  vi.useFakeTimers();
  const { loadPublicRepositoryAnnouncements } =
    await import("./repositoryCache");
  const announcement = { ...root, kind: 30617, tags: [["d", "slow-public"]] };
  let release!: (events: NostrEvent[]) => void;
  const result = firstValueFrom(
    loadPublicRepositoryAnnouncements(
      "slow-public",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  );
  await vi.advanceTimersByTimeAsync(3500);
  release([announcement]);
  expect(await result).toEqual([announcement]);
});
