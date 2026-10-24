import { afterEach, expect, it, vi } from "vitest";
import { firstValueFrom } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import {
  loadRepositoryCache,
  REPOSITORY_CACHE_DEADLINE_MS,
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
it("bounds storage waiting and stops dependent reads after timeout", async () => {
  vi.useFakeTimers();
  let release: (events: NostrEvent[]) => void = () => {};
  const pending = new Promise<NostrEvent[]>((resolve) => {
    release = resolve;
  });
  const read = vi.fn().mockReturnValue(pending);
  const result = firstValueFrom(
    loadRepositoryCache(["30617:owner:repo"], read),
  );
  await vi.advanceTimersByTimeAsync(REPOSITORY_CACHE_DEADLINE_MS);
  expect(await result).toEqual([]);
  release([root]);
  await pending;
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
