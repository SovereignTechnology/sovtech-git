import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
import {
  firstValueFrom,
  tap,
  timeout,
  toArray,
  ReplaySubject,
  take,
  switchMap,
} from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { createReconciledHistory } from "@/lib/reconciledHistory";
import { RelayEventPresence } from "@/lib/relayEventPresence";
import {
  isHistoryTerminalError,
  resilientHistoryRequest,
  resilientNegentropy,
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
  it("shares signed missing bodies across overlapping filters on separate relay connections", async () => {
    // Two URLs reach the same controlled GRASP dataset through independent
    // sockets. This tests transfer sharing, not heterogeneous relay behaviour.
    const urls = [server.relayUrl, `${server.relayUrl}?overlap=1`];
    const scopedStore = new EventStore();
    const scopedPresence = new RelayEventPresence();
    events.slice(0, 8).forEach((event) => scopedStore.add(event));
    const ids = events.slice(8).map((event) => event.id);
    let bodyFrames = 0;
    const observations = urls.map((url) =>
      pool.relay(url).message$.subscribe((message: unknown) => {
        if (Array.isArray(message) && message[0] === "EVENT") bodyFrames++;
      }),
    );
    try {
      await Promise.all(
        urls.map((url) =>
          firstValueFrom(
            resilientHistoryRequest(pool, url, [{ ids }]).pipe(
              timeout(15000),
              toArray(),
            ),
          ),
        ),
      );
      expect(bodyFrames).toBe(24);
      const unsharedFrames = bodyFrames;
      bodyFrames = 0;
      let negotiations = 0;
      const bothNegotiated = new ReplaySubject<void>(1);
      const load = createReconciledHistory(pool, scopedStore, scopedPresence, {
        negotiate: (url, inventory, filter) =>
          resilientNegentropy(pool, url, inventory, filter).pipe(
            tap({
              complete: () => {
                if (++negotiations === 2) bothNegotiated.next();
              },
            }),
          ),
        // An observable barrier guarantees overlapping demand before delivery.
        // It is test-only: production never waits for every relay to negotiate.
        request: (url, filters) =>
          bothNegotiated.pipe(
            take(1),
            switchMap(() => resilientHistoryRequest(pool, url, filters)),
          ),
      });
      const completion: boolean[] = [];
      const options = {
        limit: 5,
        isTerminalError: isHistoryTerminalError,
        onComplete: (covered: boolean) => completion.push(covered),
      };
      const results = await Promise.all([
        firstValueFrom(
          load(urls[0], [{ kinds: [1621], "#a": [coordinate] }], options).pipe(
            tap((e) => scopedStore.add(e)),
            timeout(30000),
            toArray(),
          ),
        ),
        firstValueFrom(
          load(
            urls[1],
            [{ kinds: [1621], authors: [events[0].pubkey] }],
            options,
          ).pipe(
            tap((e) => scopedStore.add(e)),
            timeout(30000),
            toArray(),
          ),
        ),
      ]);
      for (const result of results)
        expect(new Set(result.map((e) => e.id))).toEqual(
          new Set(events.map((e) => e.id)),
        );
      expect(completion).toEqual([true, true]);
      expect(bodyFrames).toBe(12);
      for (const url of urls)
        expect(
          events.every((event) => scopedPresence.has(event.id, [url])),
        ).toBe(true);
      console.log(
        JSON.stringify({
          unsharedFrames,
          sharedFrames: bodyFrames,
          uniqueMissing: 12,
        }),
      );
      bothNegotiated.complete();
    } finally {
      observations.forEach((sub) => sub.unsubscribe());
      scopedStore.dispose();
    }
  }, 60000);
});
