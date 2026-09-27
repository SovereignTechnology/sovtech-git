import { nip19 } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_BOOTSTRAP_RELAYS } from "@/actions/account";
import { DEFAULT_BLOSSOM_SERVERS } from "@/lib/blossom";
import { DEFAULT_CORS_PROXY_BASE } from "@/lib/git-grasp-pool/cors-proxy";
import { getGitWorkshopPath } from "@/lib/gitworkshopUrl";
import { normalizeGraspServiceAddress } from "@/lib/grasp";
import { parseUpstreamInput } from "@/lib/repoUpstreamInput";
import {
  DEFAULT_FALLBACK_RELAYS,
  DEFAULT_GIT_INDEX_RELAYS,
  DEFAULT_GRASP_SERVERS,
  DEFAULT_LOOKUP_RELAYS,
  DEFAULT_NOSTR_CONNECT_RELAYS,
  defaultNostrConnectRelays,
  fallbackRelays,
} from "@/services/settings";
import {
  BOOTSTRAP_RELAYS,
  FALLBACK_RELAYS,
  GRASP_SERVERS,
  NOSTR_CONNECT_RELAYS,
  WEB_HOSTS,
  isSovtechWebHost,
} from "@/sovtech/defaults";

// account.ts publishes through these services; this file only reads its
// relay list, so it needs neither the relay pool nor the outbox.
vi.mock("@/services/nostr", () => ({ eventStore: {} }));
vi.mock("@/services/outbox", () => ({ outboxStore: {} }));

/** Relays banned on the SovTech estate, matched with their subdomains. */
const BANNED_HOSTS = ["nos.lol", "nostr.mom"];

const HEX_PUBKEY =
  "da74d4da0507527520e4f9e752d9596597c900c1264d03b5fb7ec9de31873b80";
const NPUB = nip19.npubEncode(HEX_PUBKEY);

function hostOf(value: string): string {
  const withScheme = value.includes("://") ? value : `wss://${value}`;
  return new URL(withScheme).hostname.toLowerCase();
}

function isBanned(value: string): boolean {
  const host = hostOf(value);
  for (const banned of BANNED_HOSTS) {
    if (host === banned || host.endsWith(`.${banned}`)) return true;
  }
  return false;
}

describe("SovTech defaults", () => {
  it("puts SovTech's GRASP pair first in the fallback relays", () => {
    const expected = [
      "wss://git.sovit.xyz",
      "wss://git.buildinelsalvador.com",
      "wss://relay.damus.io",
      "wss://relay.primal.net",
      "wss://relay.ditto.pub",
      "wss://offchain.pub",
    ];
    expect(DEFAULT_FALLBACK_RELAYS).toEqual(expected);
    expect(fallbackRelays.getValue()).toEqual(expected);
  });

  it("offers SovTech's GRASP servers first, in upstream's address form", () => {
    expect(DEFAULT_GRASP_SERVERS).toEqual([
      "git.sovit.xyz",
      "git.buildinelsalvador.com",
      "relay.ngit.dev",
    ]);
    const forms = DEFAULT_GRASP_SERVERS.map(normalizeGraspServiceAddress);
    expect(forms).toEqual([...DEFAULT_GRASP_SERVERS]);
  });

  it("swaps nos.lol for relay.nos.social in the NIP-46 relays", () => {
    const expected = [
      "wss://bucket.coracle.social",
      "wss://relay.nos.social",
      "wss://relay.ditto.pub",
      "wss://relay.primal.net",
      "wss://nrs.primal.net",
    ];
    expect(DEFAULT_NOSTR_CONNECT_RELAYS).toEqual(expected);
    expect(defaultNostrConnectRelays.getValue()).toEqual(expected);
  });

  it("swaps nos.lol for relay.primal.net in the bootstrap relays", () => {
    expect(ACCOUNT_BOOTSTRAP_RELAYS).toEqual([
      "wss://relay.ditto.pub",
      "wss://relay.damus.io",
      "wss://relay.primal.net",
    ]);
  });

  it("freezes every SovTech list", () => {
    const lists = [
      FALLBACK_RELAYS,
      GRASP_SERVERS,
      NOSTR_CONNECT_RELAYS,
      BOOTSTRAP_RELAYS,
      WEB_HOSTS,
    ];
    for (const list of lists) expect(Object.isFrozen(list)).toBe(true);
  });

  it("keeps the ngit git index relay so repositories stay discoverable", () => {
    expect(DEFAULT_GIT_INDEX_RELAYS).toContain("wss://index.ngit.dev");
  });

  it("never names nos.lol or nostr.mom in any default list", () => {
    const lists: Record<string, readonly string[]> = {
      fallback: DEFAULT_FALLBACK_RELAYS,
      lookup: DEFAULT_LOOKUP_RELAYS,
      gitIndex: DEFAULT_GIT_INDEX_RELAYS,
      nostrConnect: DEFAULT_NOSTR_CONNECT_RELAYS,
      grasp: DEFAULT_GRASP_SERVERS,
      bootstrap: ACCOUNT_BOOTSTRAP_RELAYS,
      blossom: DEFAULT_BLOSSOM_SERVERS,
      corsProxy: [DEFAULT_CORS_PROXY_BASE],
    };
    // Control: the matcher fires on the banned hosts and their subdomains.
    expect(isBanned("wss://nos.lol")).toBe(true);
    expect(isBanned("wss://relay.nostr.mom/")).toBe(true);
    expect(isBanned("wss://chronos.lol")).toBe(false);
    for (const [name, list] of Object.entries(lists)) {
      expect(list.length, name).toBeGreaterThan(0);
      for (const value of list) {
        expect(isBanned(value), `${name}: ${value}`).toBe(false);
      }
    }
  });
});

describe("SovTech web hosts", () => {
  it("matches SovTech's hosts in any case and nothing else", () => {
    expect(isSovtechWebHost("git.sovtech.pro")).toBe(true);
    expect(isSovtechWebHost("GIT.SOVIT.XYZ")).toBe(true);
    expect(isSovtechWebHost("sovtech.pro")).toBe(false);
    expect(isSovtechWebHost("git.sovtech.pro.example")).toBe(false);
    expect(isSovtechWebHost(undefined)).toBe(false);
  });

  it("routes https links to SovTech's hosts in-app, next to upstream's", () => {
    const path = `/${NPUB}/my-repo?tab=code#top`;
    const hosts = ["git.sovtech.pro", "git.sovit.xyz", "gitworkshop.dev"];
    for (const host of hosts) {
      expect(getGitWorkshopPath(`https://${host}${path}`)).toBe(path);
    }
    const plaintext = `http://git.sovtech.pro${path}`;
    const lookalike = `https://git.sovtech.pro.example${path}`;
    expect(getGitWorkshopPath(plaintext)).toBeNull();
    expect(getGitWorkshopPath(lookalike)).toBeNull();
  });

  it("parses a bare SovTech repository link as an upstream", () => {
    for (const host of ["git.sovtech.pro", "git.sovit.xyz"]) {
      const parsed = parseUpstreamInput(`${host}/${NPUB}/my-repo`);
      expect(parsed.upstream.repository).toBe(`30617:${HEX_PUBKEY}:my-repo`);
      expect(parsed.pendingNip05).toBeUndefined();
    }
  });
});
