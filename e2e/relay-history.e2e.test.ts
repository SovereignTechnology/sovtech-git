import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
import { firstValueFrom, tap, timeout, toArray } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { createReconciledHistory } from "@/lib/reconciledHistory";
import { RelayEventPresence } from "@/lib/relayEventPresence";
import {
  isHistoryTerminalError,
  resilientHistoryRequest,
} from "@/lib/resilientSubscription";
import {
  GraspServer,
  RelayClient,
  TestSigner,
  seedRepo,
  graspBinaryAvailable,
} from "./harness";

const describeIfGrasp = graspBinaryAvailable() ? describe : describe.skip;
describeIfGrasp("relay reconciliation against real GRASP", () => {
  let server: GraspServer;
  let publisher: RelayClient;
  let coordinate: string;
  const pool = new RelayPool();
  const store = new EventStore();
  const presence = new RelayEventPresence();
  const events: NostrEvent[] = [];
  let received: { events: number; bytes: number; rounds: number };
  beforeAll(async () => {
    server = await GraspServer.start({ role: "nip77" });
    publisher = await RelayClient.connect(server.relayUrl);
    const signer = new TestSigner();
    const repo = await seedRepo(server, publisher, signer, {
      identifier: "sync",
      files: { "README.md": "sync" },
    });
    coordinate = repo.coordinate;
    for (let i = 0; i < 20; i++) {
      const event = await signer.signEvent({
        kind: 1621,
        created_at: Math.floor(Date.now() / 1000) - 100,
        tags: [
          ["a", coordinate],
          ["subject", `Issue ${i}`],
        ],
        content: "x".repeat(4096),
      });
      await publisher.publish(event);
      events.push(event);
    }
    pool.relay(server.relayUrl).message$.subscribe((message: unknown) => {
      if (!Array.isArray(message)) return;
      received.bytes += JSON.stringify(message).length;
      if (message[0] === "EVENT") received.events++;
      if (message[0] === "NEG-MSG") received.rounds++;
    });
  }, 30000);
  afterAll(async () => {
    pool.close();
    store.dispose();
    publisher?.close();
    await server?.stop();
  });

  it("reduces warm transfer, fetches exact partial-cache differences, and confirms local membership", async () => {
    const filter = { kinds: [1621], "#a": [coordinate] };
    received = { events: 0, bytes: 0, rounds: 0 };
    const baseline = await firstValueFrom(
      resilientHistoryRequest(pool, server.relayUrl, [filter]).pipe(
        timeout(15000),
        toArray(),
      ),
    );
    expect(new Set(baseline.map((e) => e.id))).toEqual(
      new Set(events.map((e) => e.id)),
    );
    const coldBytes = received.bytes;
    for (const event of events.slice(0, 8)) store.add(event);
    const load = createReconciledHistory(pool, store, presence);
    const completion: boolean[] = [];
    const options = {
      limit: 5,
      isTerminalError: isHistoryTerminalError,
      onComplete: (covered: boolean) => completion.push(covered),
    };
    received = { events: 0, bytes: 0, rounds: 0 };
    const partial = await firstValueFrom(
      load(server.relayUrl, [filter], options).pipe(
        tap((e) => store.add(e)),
        timeout(20000),
        toArray(),
      ),
    );
    expect(new Set(partial.map((e) => e.id))).toEqual(
      new Set(events.map((e) => e.id)),
    );
    expect(received.events).toBe(12);
    expect(received.rounds).toBeGreaterThan(0);
    expect(completion).toEqual([true]);
    const partialBytes = received.bytes;
    received = { events: 0, bytes: 0, rounds: 0 };
    const warm = await firstValueFrom(
      load(server.relayUrl, [filter], options).pipe(timeout(15000), toArray()),
    );
    expect(new Set(warm.map((e) => e.id))).toEqual(
      new Set(events.map((e) => e.id)),
    );
    expect(received.events).toBe(0);
    expect(received.rounds).toBeGreaterThan(0);
    expect(received.bytes).toBeLessThan(coldBytes / 10);
    expect(events.every((e) => presence.has(e.id, [server.relayUrl]))).toBe(
      true,
    );
    console.log(
      JSON.stringify({
        coldEventBytes: coldBytes,
        partialBytes,
        warmBytes: received.bytes,
        coldEvents: 20,
        partialEvents: 12,
        warmEvents: 0,
      }),
    );
  }, 60000);
});
