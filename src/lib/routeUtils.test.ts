import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { searchQueryToPubkey } from "@/lib/routeUtils";

const PUBKEY =
  "a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d";

describe("searchQueryToPubkey", () => {
  it("decodes an npub", () => {
    expect(searchQueryToPubkey(nip19.npubEncode(PUBKEY))).toBe(PUBKEY);
  });

  it("decodes an nprofile, ignoring its relay hints", () => {
    const nprofile = nip19.nprofileEncode({
      pubkey: PUBKEY,
      relays: ["wss://relay.example.com"],
    });
    expect(searchQueryToPubkey(nprofile)).toBe(PUBKEY);
  });

  it("accepts a raw 64-char hex pubkey, in either case", () => {
    expect(searchQueryToPubkey(PUBKEY)).toBe(PUBKEY);
    expect(searchQueryToPubkey(PUBKEY.toUpperCase())).toBe(PUBKEY);
  });

  it("accepts a nostr: prefix and surrounding whitespace", () => {
    expect(searchQueryToPubkey(`  nostr:${nip19.npubEncode(PUBKEY)} `)).toBe(
      PUBKEY,
    );
  });

  // The point of the restriction: these are ordinary words a user types to
  // search text, and they are also valid hex.
  it("rejects short hex prefixes so text search keeps working", () => {
    for (const word of ["add", "fed", "beef", "face", "deadbeef"]) {
      expect(searchQueryToPubkey(word)).toBeUndefined();
    }
  });

  it("rejects other identifiers and plain text", () => {
    expect(searchQueryToPubkey(nip19.noteEncode(PUBKEY))).toBeUndefined();
    expect(searchQueryToPubkey("crash on startup")).toBeUndefined();
    expect(searchQueryToPubkey("")).toBeUndefined();
    expect(searchQueryToPubkey("npub1notvalid")).toBeUndefined();
  });
});
