/**
 * NIP-82 software release actions.
 *
 * Releases and their assets are published to the publisher's outbox, the
 * fallback relays, and the repository's relays (see CreateReleaseDialog), and
 * Android releases are also expected on Zapstore. Deletion requests mirror
 * those destinations so every relay that may hold the release receives one.
 */

import type { Action } from "applesauce-actions";
import type { NostrEvent } from "nostr-tools";

import { SOFTWARE_RELEASE_KIND } from "@/casts/Software";
import { DeletionFactory } from "@/factories/DeletionFactory";
import { ZAPSTORE_RELAY_URL } from "@/hooks/useSoftwarePublisherPreflight";
import { publish } from "@/services/nostr";
import { bestEffortRelayGroupId, fixedRelayGroupId } from "@/services/outbox";

export interface DeleteSoftwareReleaseOptions {
  /** Repository coordinates whose relays received the release. */
  repoCoords: string[];
  /** Software asset events (kind:3063) to include in the same request. */
  assets?: NostrEvent[];
  /** Also send the request to Zapstore (Android releases). */
  includeZapstore?: boolean;
  /** Optional NIP-09 reason. */
  reason?: string;
}

/**
 * Send a NIP-09 deletion request for a software release (kind:30063) and,
 * optionally, the software asset events it references.
 *
 * The release is addressed by both id and coordinate so every version of the
 * release is removed. Zapstore is attempted best-effort: it is a third-party
 * relay whose acceptance must not block delivery to the publisher's relays.
 */
export function DeleteSoftwareRelease(
  release: NostrEvent,
  options: DeleteSoftwareReleaseOptions,
): Action {
  return async ({ signer, self }) => {
    if (release.kind !== SOFTWARE_RELEASE_KIND) {
      throw new Error("Not a software release event");
    }
    const events = [release, ...(options.assets ?? [])];
    for (const ev of events) {
      if (ev.pubkey !== self) {
        throw new Error(
          `Cannot delete event ${ev.id.slice(0, 8)}: not authored by current account`,
        );
      }
    }

    const signed = await DeletionFactory.forEventsAndAddresses(
      events,
      options.reason,
    ).sign(signer);

    const groupIds = [...options.repoCoords];
    if (options.includeZapstore) {
      const zapstore = fixedRelayGroupId([ZAPSTORE_RELAY_URL]);
      if (zapstore) groupIds.push(bestEffortRelayGroupId(zapstore));
    }

    // publish() adds the request to the local store immediately so the UI
    // reacts, then delivers durably to outbox + fallback + the groups above.
    publish(signed, groupIds).catch(console.error);
  };
}
