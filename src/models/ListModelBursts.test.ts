import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { fakeVerifyEvent } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { IssueListModel } from "./IssueListModel";
import { PRListModel } from "./PRListModel";
import type { ResolvedIssueLite, ResolvedPRLite } from "@/lib/nip34";

const hex = (n: number) => n.toString(16).padStart(64, "0");
const coordinate = `30617:${hex(1)}:burst-fixture`;
function event(n: number, kind: number, tags: string[][]): NostrEvent {
  return {
    id: hex(n),
    pubkey: hex(1),
    created_at: 1700000000 + n,
    kind,
    tags,
    content: "fixture",
    sig: "0".repeat(128),
  };
}

describe("list model bursts", () => {
  afterEach(() => vi.useRealTimers());
  it("retains the final comments and authorised status while bounding list emissions", async () => {
    vi.useFakeTimers();
    const store = new EventStore();
    store.verifyEvent = fakeVerifyEvent;
    const issue = event(2, 1621, [
      ["a", coordinate],
      ["subject", "Issue"],
    ]);
    const pr = event(3, 1618, [
      ["a", coordinate],
      ["subject", "PR"],
      ["c", "a".repeat(40)],
    ]);
    store.add(issue);
    store.add(pr);
    const issues: ResolvedIssueLite[][] = [],
      prs: ResolvedPRLite[][] = [];
    const subs = [
      IssueListModel(coordinate)(store).subscribe((v) => issues.push(v)),
      PRListModel(coordinate)(store).subscribe((v) => prs.push(v)),
    ];
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(issues.at(-1)?.[0].commentCount).toBe(0);
      expect(prs.at(-1)?.[0].commentCount).toBe(0);
      const counts = [issues.length, prs.length];
      for (let n = 10; n < 90; n++) {
        const root = n % 2 ? pr : issue;
        store.add(
          event(n, 1111, [
            ["E", root.id],
            ["K", String(root.kind)],
            ["P", root.pubkey],
            ["e", root.id],
            ["k", String(root.kind)],
            ["p", root.pubkey],
          ]),
        );
      }
      store.add(
        event(100, 1631, [
          ["e", issue.id],
          ["a", coordinate],
        ]),
      );
      // Two nested coalescing stages each have a bounded 100ms trailing window.
      await vi.advanceTimersByTimeAsync(200);
      expect(issues.at(-1)?.[0].commentCount).toBe(40);
      expect(prs.at(-1)?.[0].commentCount).toBe(40);
      expect(issues.at(-1)?.[0].status).toBe("resolved");
      expect(issues.length - counts[0]).toBeLessThanOrEqual(3);
      expect(prs.length - counts[1]).toBeLessThanOrEqual(3);
      subs.forEach((sub) => sub.unsubscribe());
      const settled = [issues.length, prs.length];
      store.add(
        event(101, 1630, [
          ["e", issue.id],
          ["a", coordinate],
        ]),
      );
      await vi.advanceTimersByTimeAsync(200);
      expect([issues.length, prs.length]).toEqual(settled);
    } finally {
      subs.forEach((sub) => sub.unsubscribe());
      store.dispose();
    }
  });
});

describe("list model query ownership", () => {
  afterEach(() => vi.useRealTimers());

  it.each([1621, 1618])(
    "releases superseded root sets for kind %s while retaining live status updates",
    async (kind) => {
      vi.useFakeTimers();
      const store = new EventStore();
      store.verifyEvent = fakeVerifyEvent;
      const snapshots: Array<Array<{ id: string; status: string }>> = [];
      const model =
        kind === 1621 ? IssueListModel(coordinate) : PRListModel(coordinate);
      const sub = model(store).subscribe((rows) => snapshots.push(rows));
      try {
        let activeListeners = 0;
        for (let n = 2; n < 14; n++) {
          store.add(
            event(n, kind, [
              ["a", coordinate],
              ["subject", `Item ${n}`],
            ]),
          );
          // Root subscriptions deliberately audit a 100ms window.
          await vi.advanceTimersByTimeAsync(100);
          expect(snapshots.at(-1)).toHaveLength(n - 1);
          if (n === 2) activeListeners = store.insert$.observers.length;
          expect(store.insert$.observers).toHaveLength(activeListeners);
        }
        const status = event(100, 1631, [
          ["e", hex(2)],
          ["a", coordinate],
        ]);
        store.add(status);
        await vi.advanceTimersByTimeAsync(200);
        expect(snapshots.at(-1)?.find((row) => row.id === hex(2))?.status).toBe(
          "resolved",
        );
        store.remove(status);
        await vi.advanceTimersByTimeAsync(200);
        expect(snapshots.at(-1)?.find((row) => row.id === hex(2))?.status).toBe(
          "open",
        );
        expect(store.insert$.observers).toHaveLength(activeListeners);
        sub.unsubscribe();
        // Only the outer, stable root timeline retains its intentional cache lease.
        expect(store.insert$.observers).toHaveLength(1);
      } finally {
        sub.unsubscribe();
        store.dispose();
      }
    },
  );

  it("keeps a shared list alive for its other consumer", async () => {
    vi.useFakeTimers();
    const store = new EventStore();
    store.verifyEvent = fakeVerifyEvent;
    const list = store.model(IssueListModel, coordinate);
    const first = list.subscribe();
    const rows: ResolvedIssueLite[][] = [];
    const second = list.subscribe((value) => rows.push(value));
    try {
      store.add(event(2, 1621, [["a", coordinate]]));
      await vi.advanceTimersByTimeAsync(100);
      const active = store.insert$.observers.length;
      first.unsubscribe();
      expect(store.insert$.observers).toHaveLength(active);
      store.add(event(3, 1621, [["a", coordinate]]));
      await vi.advanceTimersByTimeAsync(100);
      expect(rows.at(-1)).toHaveLength(2);
      expect(store.insert$.observers).toHaveLength(active);
    } finally {
      first.unsubscribe();
      second.unsubscribe();
      store.dispose();
    }
  });
});
