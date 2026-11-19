import { describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { fakeVerifyEvent } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { CuratedEventStore } from "./curatedEventStore";
import { RelayEventPresence } from "./relayEventPresence";

const event = (id: number, kind: number): NostrEvent => ({
  id: id.toString(16).padStart(64, "0"),
  kind,
  pubkey: "a".repeat(64),
  created_at: 100,
  tags: [],
  content: "",
  sig: "b".repeat(128),
});
it("toggles cached roots, comments and updates both ways without fetching or losing the canonical cache", async () => {
  const source = new EventStore();
  source.verifyEvent = fakeVerifyEvent;
  const presence = new RelayEventPresence();
  const view = new CuratedEventStore(source, presence);
  const disconnect = view.connect();
  const root = event(1, 1618),
    comment = event(2, 1111),
    update = event(3, 1619),
    profile = event(4, 0),
    ci = event(5, 39842);
  [root, comment, update, profile, ci].forEach((e) => source.add(e));
  presence.observe(root.id, "wss://repo.test");
  presence.observe(comment.id, "wss://outbox.test");
  presence.observe(update.id, "wss://outbox.test");
  view.setPolicy(["wss://repo.test"], false);
  await Promise.resolve();
  expect(
    view.store
      .getByFilters({})
      .map((e) => e.id)
      .sort(),
  ).toEqual([root.id, profile.id]);
  const changes: string[][] = [];
  const sub = view.store
    .timeline({ kinds: [1111, 1619, 39842] })
    .subscribe((events) => changes.push(events.map((e) => e.id).sort()));
  view.setPolicy(["wss://repo.test"], true);
  await vi.waitFor(() =>
    expect(changes.at(-1)).toEqual([comment.id, update.id, ci.id]),
  );
  view.setPolicy(["wss://repo.test"], false);
  await vi.waitFor(() => expect(changes.at(-1)).toEqual([]));
  expect(source.hasEvent(comment.id)).toBe(true);
  presence.reconcile(
    "wss://repo.test",
    [comment.id],
    new Set([comment.id]),
    presence.begin(),
  );
  await Promise.resolve();
  await vi.waitFor(() => expect(changes.at(-1)).toEqual([comment.id]));
  presence.reconcile(
    "wss://repo.test",
    [comment.id],
    new Set(),
    presence.begin(),
  );
  await Promise.resolve();
  await vi.waitFor(() => expect(changes.at(-1)).toEqual([]));
  sub.unsubscribe();
  disconnect();
  await Promise.resolve();
  source.dispose();
});

describe("curation lifecycle", () => {
  it("forwards writes to the canonical store and never resurrects removed originals on toggle", async () => {
    const source = new EventStore();
    source.verifyEvent = fakeVerifyEvent;
    const view = new CuratedEventStore(source, new RelayEventPresence());
    const disconnect = view.connect();
    view.setPolicy([], true);
    const root = event(1, 1621);
    view.store.add(root);
    await Promise.resolve();
    expect(source.hasEvent(root.id)).toBe(true);
    expect(view.store.hasEvent(root.id)).toBe(true);
    source.remove(root.id);
    await Promise.resolve();
    view.setPolicy([], false);
    view.setPolicy([], true);
    expect(view.store.hasEvent(root.id)).toBe(false);
    disconnect();
    await Promise.resolve();
    source.dispose();
  });
  it("allows immediate effect re-attachment and releases source observers after final unmount", async () => {
    const source = new EventStore();
    source.verifyEvent = fakeVerifyEvent;
    const view = new CuratedEventStore(source, new RelayEventPresence());
    const count = source.insert$.observers.length;
    const first = view.connect();
    first();
    const second = view.connect();
    await Promise.resolve();
    view.setPolicy([], true);
    source.add(event(1, 1621));
    await Promise.resolve();
    expect(view.store.hasEvent(event(1, 1621).id)).toBe(true);
    second();
    await Promise.resolve();
    expect(source.insert$.observers.length).toBe(count);
    source.dispose();
  });
});

it("does not rebuild admitted timelines when another relay confirms an unchanged event", async () => {
  const source = new EventStore();
  source.verifyEvent = fakeVerifyEvent;
  const presence = new RelayEventPresence();
  const view = new CuratedEventStore(source, presence);
  const disconnect = view.connect();
  const root = event(9, 1621);
  source.add(root);
  view.setPolicy(["wss://repo.test", "wss://mirror.test"], false);
  presence.observe(root.id, "wss://repo.test");
  await Promise.resolve();
  const changes: NostrEvent[][] = [];
  const sub = view.store
    .timeline({ kinds: [1621] })
    .subscribe((events) => changes.push(events));
  const before = changes.length;
  presence.observe(root.id, "wss://mirror.test");
  await Promise.resolve();
  expect(changes).toHaveLength(before);
  sub.unsubscribe();
  disconnect();
  await Promise.resolve();
  source.dispose();
});

it("paints cached roots and statuses without inventing receipts, until all relays establish absence", async () => {
  const source = new EventStore();
  source.verifyEvent = fakeVerifyEvent;
  const presence = new RelayEventPresence();
  const view = new CuratedEventStore(source, presence);
  const disconnect = view.connect();
  const relays = ["wss://one.test", "wss://two.test"];
  view.setPolicy(relays, false);
  const root = event(21, 1621);
  const status = { ...event(22, 1632), tags: [["e", root.id]] };
  source.add(status);
  source.add(root);
  presence.acceptCached([status.id, root.id]);
  await Promise.resolve();
  expect(view.store.hasEvent(root.id)).toBe(true);
  expect(view.store.hasEvent(status.id)).toBe(true);
  expect(presence.has(root.id, relays)).toBe(false);
  presence.reconcile(relays[0], [root.id], new Set(), presence.begin());
  await Promise.resolve();
  expect(view.store.hasEvent(root.id)).toBe(true);
  presence.reconcile(relays[1], [root.id], new Set(), presence.begin());
  await Promise.resolve();
  expect(view.store.hasEvent(root.id)).toBe(false);
  expect(source.hasEvent(root.id)).toBe(true);
  view.setPolicy(relays, true);
  expect(view.store.hasEvent(root.id)).toBe(true);
  view.setPolicy(relays, false);
  expect(view.store.hasEvent(root.id)).toBe(false);
  presence.observe(root.id, relays[1]);
  await Promise.resolve();
  expect(view.store.hasEvent(root.id)).toBe(true);
  disconnect();
  await Promise.resolve();
  source.dispose();
});

it("does not mistake early outbox receipt for confirmed repository absence", () => {
  const presence = new RelayEventPresence();
  const id = event(50, 1621).id;
  const relays = ["wss://a.test", "wss://b.test"];
  presence.observe(id, "wss://outbox.test");
  expect(presence.isAbsent(id, relays)).toBe(false);
  presence.reconcile(relays[0], [id], new Set(), presence.begin());
  expect(presence.isAbsent(id, relays)).toBe(false);
  presence.reconcile(relays[1], [id], new Set(), presence.begin());
  expect(presence.isAbsent(id, relays)).toBe(true);
  presence.observe(id, relays[1]);
  expect(presence.isAbsent(id, relays)).toBe(false);
  expect(presence.isAbsent(id, [])).toBe(false);
});
