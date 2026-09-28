import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifiedSymbol,
  verifyEvent,
  type NostrEvent,
} from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  hasValidSignature,
  isSignedOnlyBy,
  type SignedRepoFields,
} from "@/sovtech/signed";

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const mine = { pubkey, createdAt: 1_700_000_000, value: "SovTech Git" };

function announce(secret = key): NostrEvent {
  return finalizeEvent(
    {
      kind: 30617,
      created_at: 1_700_000_000,
      tags: [
        ["d", "sovtech-git"],
        ["name", "SovTech Git"],
      ],
      content: "",
    },
    secret,
  );
}

function repoOf(events: NostrEvent[]): SignedRepoFields {
  return {
    coordinateStatus: "active",
    confirmedMembers: [pubkey],
    confirmedAnnouncements: events,
    nameSource: mine,
    descriptionSource: mine,
  };
}

/**
 * A copy of `event` with a bad signature, marked verified the way
 * fakeVerifyEvent marks every event the EventStore takes in.
 */
function forgedFrom(event: NostrEvent): NostrEvent {
  const forged = { ...event, sig: "0".repeat(128) };
  Reflect.set(forged, verifiedSymbol, true);
  return forged;
}

describe("hasValidSignature", () => {
  it("accepts a signed event and rejects a changed one", () => {
    const event = announce();
    expect(hasValidSignature(event)).toBe(true);
    expect(hasValidSignature({ ...event, content: "changed" })).toBe(false);
  });

  it("ignores a verified mark on the stored object", () => {
    const forged = forgedFrom(announce());
    // The cached verdict fakeVerifyEvent leaves would pass a plain check.
    expect(verifyEvent(forged)).toBe(true);
    expect(hasValidSignature(forged)).toBe(false);
  });
});

describe("isSignedOnlyBy", () => {
  it("keeps a repository whose only member signed its announcement", () => {
    expect(isSignedOnlyBy(repoOf([announce()]), pubkey)).toBe(true);
  });

  it("hides a forged announcement that carries the pubkey", () => {
    const repo = repoOf([forgedFrom(announce())]);
    expect(isSignedOnlyBy(repo, pubkey)).toBe(false);
  });

  it("hides another key's announcement", () => {
    const repo = repoOf([announce(generateSecretKey())]);
    expect(isSignedOnlyBy(repo, pubkey)).toBe(false);
  });

  it("hides a repository with a second member", () => {
    const repo: SignedRepoFields = {
      ...repoOf([announce()]),
      confirmedMembers: [pubkey, getPublicKey(generateSecretKey())],
    };
    expect(isSignedOnlyBy(repo, pubkey)).toBe(false);
  });

  it("hides display fields that come from another key", () => {
    const elsewhere = {
      pubkey: getPublicKey(generateSecretKey()),
      createdAt: 1_700_000_001,
      value: "Not SovTech",
    };
    const signed = repoOf([announce()]);
    const renamed = { ...signed, nameSource: elsewhere };
    const redescribed = { ...signed, descriptionSource: elsewhere };
    expect(isSignedOnlyBy(renamed, pubkey)).toBe(false);
    expect(isSignedOnlyBy(redescribed, pubkey)).toBe(false);
  });

  it("hides inactive coordinates and repositories with no announcement", () => {
    const signed = repoOf([announce()]);
    for (const status of ["archived", "deleted", "redirect"] as const) {
      const repo = { ...signed, coordinateStatus: status };
      expect(isSignedOnlyBy(repo, pubkey)).toBe(false);
    }
    expect(isSignedOnlyBy(repoOf([]), pubkey)).toBe(false);
  });
});
