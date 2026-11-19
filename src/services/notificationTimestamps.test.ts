import { beforeEach, expect, it, vi } from "vitest";
import {
  advanceReadCutoff,
  advanceArchivedCutoff,
  type NotificationReadState,
} from "@/lib/notifications";
import {
  readNotificationTimestamps,
  retainNotificationTimestamps,
} from "./notificationTimestamps";

const account = "a".repeat(64);
const id = "b".repeat(64);
const unknown = "c".repeat(64);
const timestamp = Math.floor(Date.now() / 1000) - 3600;
const state: NotificationReadState = {
  rb: timestamp,
  ab: 0,
  ri: [id, unknown],
  ai: [id],
};

beforeEach(() => localStorage.clear());

it("compacts unloaded IDs using persistent timestamps and retains unknown IDs", () => {
  retainNotificationTimestamps(account, state, [{ id, created_at: timestamp }]);
  // Fresh reads represent another same-origin window or a reload, with no
  // notification events loaded in its EventStore.
  const cached = readNotificationTimestamps(account);
  const read = advanceReadCutoff([], state, account, cached);
  const archived = advanceArchivedCutoff([], state, account, cached);
  expect(read.ri).toEqual([unknown]);
  expect(archived.ai).toEqual([id]);
  retainNotificationTimestamps(account, { ...state, ...read, ...archived }, []);
  expect(readNotificationTimestamps(account).get(id)).toBe(timestamp);
  retainNotificationTimestamps(
    account,
    { ...state, ri: [unknown], ai: [] },
    [],
  );
  expect(readNotificationTimestamps(account).size).toBe(0);
});

it("retains unloaded read and archive IDs when timestamp evidence is missing", () => {
  const missing = { ...state, ab: timestamp };
  expect(advanceReadCutoff([], missing, account).ri).toEqual([id, unknown]);
  expect(advanceArchivedCutoff([], missing, account).ai).toEqual([id]);
});

it("isolates accounts and ignores corrupt timestamp metadata", () => {
  retainNotificationTimestamps(account, state, [{ id, created_at: timestamp }]);
  expect(readNotificationTimestamps("d".repeat(64)).size).toBe(0);
  localStorage.setItem(
    `notifications_timestamps:${account}`,
    JSON.stringify({ [id]: "not a timestamp", [unknown]: -1 }),
  );
  expect(readNotificationTimestamps(account).size).toBe(0);
  localStorage.setItem(`notifications_timestamps:${account}`, "invalid JSON");
  expect(readNotificationTimestamps(account).size).toBe(0);
});

it("falls back to retaining IDs when cache storage is unavailable", () => {
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  try {
    expect(() =>
      retainNotificationTimestamps(account, state, [
        { id, created_at: timestamp },
      ]),
    ).not.toThrow();
    expect(
      advanceReadCutoff([], state, account, readNotificationTimestamps(account))
        .ri,
    ).toEqual([id, unknown]);
  } finally {
    write.mockRestore();
  }
});
