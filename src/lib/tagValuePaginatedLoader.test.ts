import { subscribeSpyTo } from "@hirez_io/observer-spy";
import type { NostrEvent } from "nostr-tools";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";
import { Relay, RelayPool } from "applesauce-relay";
import { createPaginatedTagValueLoader } from "@/lib/tagValuePaginatedLoader";

const RELAY_URL = "wss://tag-loader.test";

function taggedEvent(id: string, target: string): NostrEvent {
  return {
    kind: 7,
    id,
    pubkey: "dd" + "0".repeat(62),
    created_at: 1_700_000_000,
    tags: [["e", target]],
    content: "+",
    sig: "ee" + "0".repeat(126),
  };
}

describe("createPaginatedTagValueLoader batching", () => {
  let server: WS;
  let pool: RelayPool;

  beforeEach(() => {
    vi.spyOn(Relay, "fetchInformationDocument").mockImplementation(() =>
      Promise.resolve(null),
    );
    server = new WS(RELAY_URL, { jsonProtocol: true });
    pool = new RelayPool();

    const originalRelay = pool.relay.bind(pool);
    vi.spyOn(pool, "relay").mockImplementation((url: string) => {
      const relay = originalRelay(url);
      relay.keepAlive = 0;
      relay.reconnectTimer = () => of(0);
      return relay;
    });
  });

  afterEach(async () => {
    await WS.clean();
    vi.clearAllMocks();
  });

  it("delivers the batch to the pointer that fills bufferSize", async () => {
    const loader = createPaginatedTagValueLoader(pool, "e", {
      bufferTime: 60_000,
      bufferSize: 2,
      settleTime: 1,
    });

    const first = subscribeSpyTo(
      loader({ value: "first-target", relays: [RELAY_URL] }),
    );
    const second = subscribeSpyTo(
      loader({ value: "batch-edge-target", relays: [RELAY_URL] }),
    );

    const request = (await server.nextMessage) as [
      string,
      string,
      { "#e": string[] },
    ];
    expect(request[0]).toBe("REQ");
    expect(request[2]["#e"]).toEqual(["first-target", "batch-edge-target"]);

    const firstEvent = taggedEvent("11".repeat(32), "first-target");
    const secondEvent = taggedEvent("22".repeat(32), "batch-edge-target");
    server.send(["EVENT", request[1], firstEvent]);
    server.send(["EVENT", request[1], secondEvent]);

    await vi.waitFor(
      () => {
        expect(first.getValues().map((event) => event.id)).toContain(
          firstEvent.id,
        );
        expect(second.getValues().map((event) => event.id)).toContain(
          secondEvent.id,
        );
      },
      { timeout: 1_000 },
    );

    first.unsubscribe();
    second.unsubscribe();
  });
  it("loads beyond a short relay page and keeps the original live subscription", async () => {
    const statuses: string[] = [];
    const loader = createPaginatedTagValueLoader(pool, "e", {
      bufferTime: 1,
      limit: 5,
      settleTime: 1,
      onHistoryStatus: (status) => statuses.push(status.state),
    });
    const observed = subscribeSpyTo(
      loader({ value: "thread", relays: [RELAY_URL] }),
    );
    const events = [110, 100, 90].map((time, index) => ({
      ...taggedEvent((index + 1).toString(16).padStart(64, "0"), "thread"),
      created_at: time,
    }));
    const initial = (await server.nextMessage) as [
      string,
      string,
      Record<string, unknown>,
    ];
    events
      .slice(0, 2)
      .forEach((event) => server.send(["EVENT", initial[1], event]));
    server.send(["EOSE", initial[1]]);
    // Serve actual v7 REQs. CLOSE frames can arrive between pages.
    let pages = 0;
    while (pages < 2) {
      const frame = (await server.nextMessage) as [
        string,
        string,
        { until: number },
      ];
      if (frame[0] !== "REQ") continue;
      pages++;
      events
        .filter((event) => event.created_at <= frame[2].until)
        .slice(0, 2)
        .forEach((event) => server.send(["EVENT", frame[1], event]));
      server.send(["EOSE", frame[1]]);
    }
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("covered"), {
      timeout: 1000,
    });
    const live = { ...taggedEvent("ff".repeat(32), "thread"), created_at: 130 };
    server.send(["EVENT", initial[1], live]);
    await vi.waitFor(
      () =>
        expect(
          new Set(
            observed
              .getValues()
              .filter((event) => typeof event !== "string")
              .map((event) => event.id),
          ),
        ).toEqual(new Set([...events, live].map((event) => event.id))),
      { timeout: 1000 },
    );
    observed.unsubscribe();
  }, 10_000);
});
