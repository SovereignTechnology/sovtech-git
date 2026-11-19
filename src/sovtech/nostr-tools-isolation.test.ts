import { fakeVerifyEvent } from "applesauce-core/helpers";
import {
  finalizeEvent,
  generateSecretKey,
  verifyEvent,
  type NostrEvent,
} from "nostr-tools";
import { describe, expect, it } from "vitest";

/**
 * Tripwire for a silent loss of signature checking.
 *
 * The app's EventStore does not verify signatures: src/services/nostr.ts sets
 * applesauce's fakeVerifyEvent, which marks every event it sees as verified.
 * nostr-tools keeps that verdict on the event object under a module-private
 * symbol, so the app's own verifyEvent calls (private repository scope, git
 * HTTP auth) still check the signature for real only while applesauce and the
 * app resolve to two separate copies of nostr-tools. A dependency dedupe or a
 * version alignment would make them share the symbol and turn every stored
 * event into a verified one, with no error anywhere.
 *
 * This test uses the real fakeVerifyEvent, so it fails when that happens.
 * If it fails after an upstream sync, do not publish: restore two copies in
 * pnpm-lock.yaml, or move every verifyEvent call onto a fresh copy of the
 * signed fields as src/sovtech/signed.ts does.
 */
describe("nostr-tools isolation", () => {
  /**
   * The signed fields only. finalizeEvent marks its result as verified under
   * the symbol key, and a spread would copy that mark, so the events below
   * are built field by field and start with no cached verdict.
   */
  function fresh(event: NostrEvent, content = event.content): NostrEvent {
    const { id, pubkey, created_at, kind, tags, sig } = event;
    return { id, pubkey, created_at, kind, tags, content, sig };
  }

  function signed(): NostrEvent {
    return finalizeEvent(
      {
        kind: 1,
        created_at: 1_700_000_000,
        tags: [],
        content: "isolation canary",
      },
      generateSecretKey(),
    );
  }

  it("verifies a genuine event", () => {
    expect(verifyEvent(fresh(signed()))).toBe(true);
  });

  it("rejects a forged event that fakeVerifyEvent marked", () => {
    const forged = fresh(signed(), "changed after signing");
    expect(fakeVerifyEvent(forged)).toBe(true);
    expect(verifyEvent(forged)).toBe(false);
  });
});
