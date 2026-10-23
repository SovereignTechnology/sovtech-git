import { describe, expect, it } from "vitest";
import { EventStore } from "applesauce-core";
import { fakeVerifyEvent, type Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";

const hex = (n: number) => n.toString(16).padStart(64, "0");
const tags = Array.from({ length: 500 }, (_, i) => hex(i + 1));
function event(i: number): NostrEvent {
  return {
    id: hex(i + 10000),
    pubkey: hex(1 + (i % 3)),
    sig: "0".repeat(128),
    kind: i % 4 ? 1111 : 1,
    created_at: 1700000000 + Math.floor(i / 3),
    tags: [
      ["E", tags[i % 500]],
      ["E", tags[(i + 1) % 500]],
      ["p", hex(1 + (i % 2))],
    ],
    content: "query fixture",
  };
}
function expected(events: NostrEvent[], filter: Filter): string[] {
  const matching = events
    .filter((e) => {
      if (filter.ids && !filter.ids.includes(e.id)) return false;
      if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
      if (filter.authors && !filter.authors.includes(e.pubkey)) return false;
      if (filter.since !== undefined && e.created_at < filter.since)
        return false;
      if (filter.until !== undefined && e.created_at > filter.until)
        return false;
      for (const [key, values] of Object.entries(filter)) {
        if (!key.startsWith("#") || !Array.isArray(values)) continue;
        if (
          !e.tags.some(
            (tag) =>
              tag[0] === key.slice(1) &&
              values.some((value) => value === tag[1]),
          )
        )
          return false;
      }
      return true;
    })
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  return (filter.limit ? matching.slice(0, filter.limit) : matching)
    .map((e) => e.id)
    .sort();
}

describe("patched Applesauce broad index unions", () => {
  it("preserves OR, intersections, time bounds, missing tags and NIP-01 limits", () => {
    const store = new EventStore();
    store.verifyEvent = fakeVerifyEvent;
    const events = Array.from({ length: 2000 }, (_, i) => event(i));
    events.forEach((e) => store.add(e));
    try {
      for (const width of [1, 20, 200, 500])
        for (const limit of [undefined, 1, 20, 500]) {
          const filter: Filter = {
            kinds: [1, 1111],
            "#E": [...tags.slice(0, width), hex(9999)],
            authors: [hex(1), hex(2)],
            "#p": [hex(1)],
            since: 1700000100,
            until: 1700000600,
            ...(limit ? { limit } : {}),
          };
          expect(
            store
              .getByFilters(filter)
              .map((e) => e.id)
              .sort(),
          ).toEqual(expected(events, filter));
          expect(
            store
              .getSyncPairs(filter)
              .map((e) => e.id)
              .sort(),
          ).toEqual(expected(events, filter));
        }
      expect(store.getByFilters({ kinds: [9999], "#E": tags })).toEqual([]);
      const intersection: Filter = {
        "#E": tags,
        "&p": [hex(1)],
        kinds: [1, 1111],
      };
      expect(
        store
          .getByFilters(intersection)
          .map((e) => e.id)
          .sort(),
      ).toEqual(
        events
          .filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === hex(1)))
          .map((e) => e.id)
          .sort(),
      );
    } finally {
      store.dispose();
    }
  });

  it("does not mutate cached tag indexes and sees additions/removals after broad reads", () => {
    const store = new EventStore();
    store.verifyEvent = fakeVerifyEvent;
    const events = Array.from({ length: 2000 }, (_, i) => event(i));
    events.forEach((e) => store.add(e));
    try {
      const broad: Filter = { kinds: [1111], "#E": tags };
      const narrow: Filter = { "#E": [tags[0]] };
      for (let i = 0; i < 3; i++) store.getByFilters(broad);
      expect(
        store
          .getByFilters(narrow)
          .map((e) => e.id)
          .sort(),
      ).toEqual(expected(events, narrow));
      const added = event(2000);
      store.add(added);
      store.remove(events[0]);
      const current = [...events.slice(1), added];
      expect(
        store
          .getByFilters(broad)
          .map((e) => e.id)
          .sort(),
      ).toEqual(expected(current, broad));
      expect(
        store
          .getByFilters(narrow)
          .map((e) => e.id)
          .sort(),
      ).toEqual(expected(current, narrow));
    } finally {
      store.dispose();
    }
  });
});
