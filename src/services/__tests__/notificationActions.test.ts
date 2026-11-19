import { beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import type { NotificationReadState } from "@/lib/notifications";
import type { NotificationStoreEntry } from "@/services/notificationStore";
import { retainNotificationTimestamps } from "@/services/notificationTimestamps";

const getByFilters = vi.hoisted(() => vi.fn());

vi.mock("@/services/nostr", () => ({
  eventStore: { getByFilters },
}));

vi.mock("@/services/notificationStore", () => ({
  updateReadState: (
    entry: NotificationStoreEntry,
    updater: (prev: NotificationReadState) => NotificationReadState,
  ) => {
    entry.readState$.next(updater(entry.readState$.getValue()));
  },
}));

import {
  actionMarkAllAsRead,
  actionMarkAllAsArchived,
  actionMarkEventAsArchived,
  actionMarkEventAsRead,
  actionMarkEventsAsArchived,
  actionMarkEventsAsRead,
} from "@/services/notificationActions";

const selfPubkey = "a".repeat(64);
const notificationEvent: NostrEvent = {
  id: "b".repeat(64),
  pubkey: "c".repeat(64),
  kind: 1111,
  created_at: Math.floor(Date.now() / 1000),
  content: "Activity loaded directly by ID",
  tags: [
    ["E", "d".repeat(64)],
    ["P", selfPubkey],
    ["K", "1621"],
  ],
  sig: "e".repeat(128),
};
const existingStateEvent: NostrEvent = {
  ...notificationEvent,
  id: "f".repeat(64),
  content: "Previously acted-on direct activity",
};

interface TestFilter {
  ids?: string[];
}

function makeEntry(
  readState: NotificationReadState = { rb: 0, ri: [], ab: 0, ai: [] },
): NotificationStoreEntry {
  return {
    pubkey: selfPubkey,
    readState$: new BehaviorSubject(readState),
    repoCoords$: new BehaviorSubject([]),
    nonGitEventIds$: new BehaviorSubject(new Set()),
    historyLoader: null,
    publishTimer: null,
    lastPublishedStateAt: 0,
    cleanup: null,
    refCount: 1,
  };
}

beforeEach(() => {
  localStorage.clear();
  getByFilters.mockReset();
  getByFilters.mockImplementation((filters: TestFilter[]) => {
    const requestedIds = new Set(filters.flatMap((filter) => filter.ids ?? []));
    return [notificationEvent, existingStateEvent].filter((event) =>
      requestedIds.has(event.id),
    );
  });
});

describe("event-scoped notification actions", () => {
  it("marks directly loaded activity as read", () => {
    const entry = makeEntry();

    actionMarkEventAsRead(entry, notificationEvent.id);

    expect(entry.readState$.getValue().ri).toContain(notificationEvent.id);
  });

  it("marks a directly loaded user group as read", () => {
    const entry = makeEntry();

    actionMarkEventsAsRead(entry, [notificationEvent.id]);

    expect(entry.readState$.getValue().ri).toContain(notificationEvent.id);
  });

  it("archives and marks directly loaded user activity as read", () => {
    const entry = makeEntry();

    actionMarkEventsAsArchived(entry, [notificationEvent.id]);

    const state = entry.readState$.getValue();
    expect(state.ai).toContain(notificationEvent.id);
    expect(state.ri).toContain(notificationEvent.id);
  });

  it("preserves other direct-only state IDs during cutoff advancement", () => {
    const entry = makeEntry({
      rb: 0,
      ri: [existingStateEvent.id],
      ab: 0,
      ai: [existingStateEvent.id],
    });

    actionMarkEventsAsArchived(entry, [notificationEvent.id]);

    const state = entry.readState$.getValue();
    expect(state.ri).toEqual(
      expect.arrayContaining([existingStateEvent.id, notificationEvent.id]),
    );
    expect(state.ai).toEqual(
      expect.arrayContaining([existingStateEvent.id, notificationEvent.id]),
    );
  });

  it("marks an already archived activity as read when archived again", () => {
    const entry = makeEntry({
      rb: 0,
      ri: [],
      ab: 0,
      ai: [notificationEvent.id],
    });

    actionMarkEventAsArchived(entry, notificationEvent.id);

    expect(entry.readState$.getValue().ri).toContain(notificationEvent.id);
  });
});

it("uses cached timestamps during actions without dropping unknown unloaded IDs", () => {
  const unknown = "e".repeat(64);
  const entry = makeEntry({
    rb: 0,
    ab: 0,
    ri: [existingStateEvent.id, unknown],
    ai: [existingStateEvent.id, unknown],
  });
  retainNotificationTimestamps(selfPubkey, entry.readState$.value, [
    {
      id: existingStateEvent.id,
      created_at: Math.floor(Date.now() / 1000) - 10 * 86400,
    },
  ]);
  getByFilters.mockImplementation((filters: TestFilter[]) =>
    filters.some((filter) => filter.ids?.includes(notificationEvent.id))
      ? [notificationEvent]
      : [],
  );

  actionMarkEventsAsArchived(entry, [notificationEvent.id]);

  expect(entry.readState$.value.ri).toEqual(
    expect.arrayContaining([unknown, notificationEvent.id]),
  );
  expect(entry.readState$.value.ai).toEqual(
    expect.arrayContaining([unknown, notificationEvent.id]),
  );
  expect(entry.readState$.value.ri).not.toContain(existingStateEvent.id);
  expect(entry.readState$.value.ai).not.toContain(existingStateEvent.id);
});

it.each([actionMarkAllAsRead, actionMarkAllAsArchived])(
  "preserves unknown saved IDs in bulk actions",
  (action) => {
    const unknown = "e".repeat(64);
    const entry = makeEntry({
      rb: 0,
      ab: 0,
      ri: [existingStateEvent.id, unknown],
      ai: [existingStateEvent.id, unknown],
    });
    retainNotificationTimestamps(selfPubkey, entry.readState$.value, [
      {
        id: existingStateEvent.id,
        created_at: Math.floor(Date.now() / 1000) - 11 * 86400,
      },
    ]);
    getByFilters.mockReturnValue([]);
    action(entry);
    expect(entry.readState$.value.ri).toEqual([unknown]);
    if (action === actionMarkAllAsArchived)
      expect(entry.readState$.value.ai).toEqual([unknown]);
  },
);
