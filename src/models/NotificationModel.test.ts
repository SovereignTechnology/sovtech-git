import { expect, it } from "vitest";
import { EventStore } from "applesauce-core";
import { BehaviorSubject, filter, firstValueFrom, timeout } from "rxjs";
import type { NotificationReadState } from "@/lib/notifications";
import { NotificationModel } from "./NotificationModel";

it("uses the recreated store's read/archive state while the old model is warm", async () => {
  const store = new EventStore();
  store.verifyEvent = () => true;
  const pubkey = "a".repeat(64);
  const id = "b".repeat(64);
  store.add({
    id,
    pubkey: "c".repeat(64),
    kind: 1111,
    created_at: Math.floor(Date.now() / 1000),
    content: "Notification on an issue",
    tags: [
      ["E", "d".repeat(64)],
      ["P", pubkey],
      ["K", "1621"],
    ],
    sig: "e".repeat(128),
  });
  const oldState = new BehaviorSubject<NotificationReadState>({
    rb: 0,
    ri: [],
    ab: 0,
    ai: [],
  });
  const oldCoords = new BehaviorSubject<string[]>([]);
  const oldExcluded = new BehaviorSubject(new Set<string>());
  const oldModel = store.model(
    NotificationModel,
    pubkey,
    oldState,
    oldCoords,
    oldExcluded,
  );
  try {
    await firstValueFrom(
      oldModel.pipe(
        filter((value) => value.unreadCount === 1),
        timeout(1000),
      ),
    );
    // The cache remains warm after the page unsubscribes, but the store entry
    // has been replaced (for example by development hot reload).
    const currentState = new BehaviorSubject<NotificationReadState>({
      rb: 0,
      ri: [id],
      ab: 0,
      ai: [id],
    });
    const coords = new BehaviorSubject<string[]>([]);
    const excluded = new BehaviorSubject(new Set<string>());
    const currentModel = store.model(
      NotificationModel,
      pubkey,
      currentState,
      coords,
      excluded,
    );
    expect(
      store.model(NotificationModel, pubkey, currentState, coords, excluded),
    ).toBe(currentModel);
    const archived = await firstValueFrom(
      currentModel.pipe(
        filter((value) => value.items.length === 1),
        timeout(1000),
      ),
    );
    expect(archived.unreadCount).toBe(0);
    expect(archived.items[0].archived).toBe(true);

    const restored = firstValueFrom(
      currentModel.pipe(
        filter((value) => value.unreadCount === 1),
        timeout(1000),
      ),
    );
    currentState.next({ rb: 0, ri: [], ab: 0, ai: [] });
    expect((await restored).items[0].archived).toBe(false);
  } finally {
    store.dispose();
  }
});
