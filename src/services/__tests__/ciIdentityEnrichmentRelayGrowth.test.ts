/**
 * Verifies the shared per-identity CI enrichment owner grows its relay set
 * additively: a relay added to the discovery settings after the query opened
 * receives one REQ of its own carrying the full enrichment filter, while the
 * REQ already open on the existing relay is neither closed nor re-sent.
 *
 * Uses vitest-websocket-mock like resilientAdditiveSubscription.test.ts so
 * the real relay stack (RelayPool → Relay → WebSocket) runs unmodified.
 */

import { Relay } from "applesauce-relay";
import type { Filter } from "applesauce-core/helpers";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Subscription } from "rxjs";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";

import {
  CI_IDENTITY_ENRICHMENT_KINDS,
  ciIdentityEnrichment$,
} from "@/services/ciQueries";
import { eventStore, pool } from "@/services/nostr";
import { isValidCIProviderAdvertisement } from "@/casts/CIProvider";
import { gitIndexRelays, lookupRelays } from "@/services/settings";

let RELAY_A: string;
let RELAY_B: string;
let relayFixture = 0;

type ReqMessage = ["REQ", string, ...Filter[]];

// Shared owners linger for 60 seconds; count only this fixture identity.
function requests(server: WS, pubkey: string): ReqMessage[] {
  return server.messages.filter(
    (message): message is ReqMessage =>
      Array.isArray(message) &&
      message[0] === "REQ" &&
      (message[2] as Filter).authors?.includes(pubkey) === true,
  );
}

function closes(server: WS, pubkey: string): Array<["CLOSE", string]> {
  const ids = new Set(requests(server, pubkey).map((request) => request[1]));
  return server.messages.filter(
    (message): message is ["CLOSE", string] =>
      Array.isArray(message) && message[0] === "CLOSE" && ids.has(message[1]),
  );
}

let serverA: WS;
let serverB: WS;
let querySub: Subscription | undefined;

beforeEach(() => {
  relayFixture += 1;
  RELAY_A = `wss://enrichment-initial-${relayFixture}.test`;
  RELAY_B = `wss://enrichment-joined-${relayFixture}.test`;
  vi.spyOn(Relay, "fetchInformationDocument").mockImplementation(() =>
    Promise.resolve(null),
  );
  serverA = new WS(RELAY_A, { jsonProtocol: true });
  serverB = new WS(RELAY_B, { jsonProtocol: true });

  // Disable keep-alive pings and the 1s+ reconnect backoff on the singleton
  // pool's relays so the mock servers see only protocol frames.
  for (const url of [RELAY_A, RELAY_B]) {
    const relay = pool.relay(url);
    relay.keepAlive = 0;
    relay.reconnectTimer = () => of(0);
  }

  lookupRelays.next([RELAY_A]);
  gitIndexRelays.next([]);
});

afterEach(async () => {
  querySub?.unsubscribe();
  querySub = undefined;
  // The keyed share lingers past the unsubscribe — drain the discovery relay
  // lists so the lingering query leaves the mock relays before they close.
  lookupRelays.next([]);
  gitIndexRelays.next([]);
  await WS.clean();
  vi.restoreAllMocks();
});

describe("ciIdentityEnrichment$", () => {
  it("adds a grown discovery relay as one new REQ without disturbing the existing relay", async () => {
    const pubkey = getPublicKey(generateSecretKey());
    const enrichmentFilter = {
      kinds: [...CI_IDENTITY_ENRICHMENT_KINDS],
      authors: [pubkey],
    };

    querySub = ciIdentityEnrichment$(pubkey).subscribe();

    await vi.waitFor(() => expect(requests(serverA, pubkey)).toHaveLength(1));
    expect(requests(serverA, pubkey)[0].slice(2)).toEqual([enrichmentFilter]);
    expect(requests(serverB, pubkey)).toHaveLength(0);

    // A relay appearing in the settings later grows the discovery set. The
    // old implementation restarted the whole query here (CLOSE on the
    // existing relay + full re-REQ everywhere); the additive subscription
    // must open one REQ on the new relay alone.
    gitIndexRelays.next([RELAY_B]);

    await vi.waitFor(() => expect(requests(serverB, pubkey)).toHaveLength(1));
    expect(requests(serverB, pubkey)[0].slice(2)).toEqual([enrichmentFilter]);
    expect(requests(serverA, pubkey)).toHaveLength(1);
    expect(closes(serverA, pubkey)).toHaveLength(0);
  });

  it("loads an offering found only on an explicit relay hint", async () => {
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    const createdAt = Math.floor(Date.now() / 1000);
    const advertisement = finalizeEvent(
      {
        kind: 39845,
        created_at: createdAt,
        content: "",
        tags: [
          ["d", "default"],
          ["W", "nix"],
          ["S", "nix:x86_64-linux"],
          [
            "allocation-key",
            "nip44-v2",
            getPublicKey(generateSecretKey()),
            RELAY_B,
          ],
          ["isolation", "hardware-vm"],
          ["capacity", "1", "1"],
          ["expiration", String(createdAt + 1800)],
        ],
      },
      key,
    );
    querySub = ciIdentityEnrichment$(pubkey, [
      RELAY_B + "/",
      RELAY_B,
      "https://invalid.test",
    ]).subscribe();
    await vi.waitFor(() => expect(requests(serverA, pubkey)).toHaveLength(1));
    await vi.waitFor(() => expect(requests(serverB, pubkey)).toHaveLength(1));
    expect(requests(serverB, pubkey)[0][2]).toEqual({
      kinds: [...CI_IDENTITY_ENRICHMENT_KINDS],
      authors: [pubkey],
    });
    serverA.send(["EOSE", requests(serverA, pubkey)[0][1]]);
    serverB.send(["EVENT", requests(serverB, pubkey)[0][1], advertisement]);
    serverB.send(["EOSE", requests(serverB, pubkey)[0][1]]);
    await vi.waitFor(() =>
      expect(eventStore.getEvent(advertisement.id)).toBeDefined(),
    );
    expect(
      isValidCIProviderAdvertisement(eventStore.getEvent(advertisement.id)!),
    ).toBe(true);
    expect(requests(serverB, pubkey)).toHaveLength(1);
  });

  it("adds hints to an already shared identity without restarting existing REQs", async () => {
    const pubkey = getPublicKey(generateSecretKey());
    const owner = ciIdentityEnrichment$(pubkey);
    querySub = owner.subscribe();
    await vi.waitFor(() => expect(requests(serverA, pubkey)).toHaveLength(1));
    expect(ciIdentityEnrichment$(pubkey, [RELAY_B])).toBe(owner);
    await vi.waitFor(() => expect(requests(serverB, pubkey)).toHaveLength(1));
    expect(ciIdentityEnrichment$(pubkey, [RELAY_B + "/"])).toBe(owner);
    expect(requests(serverA, pubkey)).toHaveLength(1);
    expect(requests(serverB, pubkey)).toHaveLength(1);
    expect(closes(serverA, pubkey)).toHaveLength(0);
  });

  it("discovers offerings through a NIP-65 outbox arriving after the index query", async () => {
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    querySub = ciIdentityEnrichment$(pubkey).subscribe();
    await vi.waitFor(() => expect(requests(serverA, pubkey)).toHaveLength(1));
    expect(requests(serverB, pubkey)).toHaveLength(0);
    const relayList = finalizeEvent(
      {
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [["r", RELAY_B, "write"]],
      },
      key,
    );
    serverA.send(["EVENT", requests(serverA, pubkey)[0][1], relayList]);
    await vi.waitFor(() => expect(requests(serverB, pubkey)).toHaveLength(1));
    expect(requests(serverB, pubkey)[0][2]).toEqual({
      kinds: [...CI_IDENTITY_ENRICHMENT_KINDS],
      authors: [pubkey],
    });
    expect(requests(serverA, pubkey)).toHaveLength(1);
    expect(closes(serverA, pubkey)).toHaveLength(0);
  });
});
