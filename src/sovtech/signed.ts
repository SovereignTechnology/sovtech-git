/**
 * Signature checks for fork code that shows events under a first-party
 * heading, such as the landing page's "From SovTech" strip.
 *
 * The app's EventStore does not verify signatures (src/services/nostr.ts sets
 * fakeVerifyEvent, see docs/signature-verification.md), so any relay the
 * session reads, and the local cache, can supply an event that carries
 * SovTech's pubkey. Upstream accepts that risk for its own pages, which make
 * no endorsement claim; a strip that says "announced by Sovereign
 * Technology's own key" must check the claim itself.
 */
import { verifyEvent, type NostrEvent } from "nostr-tools";
import type { ResolvedRepo } from "@/lib/nip34";

/**
 * Whether an event's id and signature check out.
 *
 * nostr-tools caches its verdict on the event object, and fakeVerifyEvent
 * writes that cache as true. The check therefore runs on a fresh copy of the
 * signed fields, never on the stored object, as upstream's
 * src/lib/private-git-relays.ts does. Otherwise a dependency dedupe that put
 * applesauce and the app on one nostr-tools would make every stored event
 * pass.
 */
export function hasValidSignature(event: NostrEvent): boolean {
  const { id, pubkey, created_at, kind, tags, content, sig } = event;
  return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig });
}

/** The fields of a resolved repository that decide what a card shows. */
export type SignedRepoFields = Pick<
  ResolvedRepo,
  | "coordinateStatus"
  | "confirmedMembers"
  | "confirmedAnnouncements"
  | "nameSource"
  | "descriptionSource"
>;

/**
 * Whether everything a repository card shows comes from announcements that
 * `pubkey` signed.
 *
 * A card's name, description and time come from the latest announcement of
 * a confirmed member. So `pubkey` must be the only confirmed member (no
 * co-maintainer or moderator supplies them), the coordinate must be active
 * (an archived or deleted one presents a historical snapshot instead), both
 * display fields must come from `pubkey`, and every confirmed announcement
 * must be `pubkey`'s and verify. A forged announcement hides the repository;
 * it never shows under the first-party heading.
 */
export function isSignedOnlyBy(
  repo: SignedRepoFields,
  pubkey: string,
): boolean {
  if (repo.coordinateStatus !== "active") return false;
  if (
    repo.confirmedMembers.length !== 1 ||
    repo.confirmedMembers[0] !== pubkey ||
    repo.nameSource.pubkey !== pubkey ||
    repo.descriptionSource.pubkey !== pubkey
  ) {
    return false;
  }
  const events = repo.confirmedAnnouncements;
  return (
    events.length > 0 &&
    events.every((event) => event.pubkey === pubkey && hasValidSignature(event))
  );
}
