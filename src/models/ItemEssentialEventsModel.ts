import { TimelineModel } from "applesauce-core/models";
import { coalesceBursts } from "@/lib/coalesceBursts";
import { of } from "rxjs";
import { map, switchMap } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import type { NostrEvent } from "nostr-tools";
import { DELETION_KIND, LABEL_KIND, STATUS_KINDS } from "@/lib/nip34";

interface ItemEssentialEvents {
  essentials: NostrEvent[];
  deletions: NostrEvent[];
}

/**
 * Store-only essentials and withdrawals. The owner may share this model, but
 * its changing inner queries must end immediately when replaced or released.
 */
export function ItemEssentialEventsModel(
  idsKey: string,
): Model<ItemEssentialEvents> {
  return (store) => {
    const ids = idsKey.split(",").filter(Boolean);
    if (ids.length === 0) return of({ essentials: [], deletions: [] });
    return TimelineModel([
      {
        kinds: [...STATUS_KINDS, LABEL_KIND, DELETION_KIND],
        "#e": ids,
      },
    ])(store).pipe(
      // A burst only needs one deletion timeline for its latest essential IDs.
      coalesceBursts(),
      switchMap((essentials) => {
        const essentialIds = essentials
          .filter((event) => event.kind !== DELETION_KIND)
          .map((event) => event.id);
        if (essentialIds.length === 0) return of({ essentials, deletions: [] });
        // Production stores remove deleted originals themselves. Also pass
        // signed withdrawals to the resolver for stores retaining originals.
        return TimelineModel([{ kinds: [DELETION_KIND], "#e": essentialIds }])(
          store,
        ).pipe(map((deletions) => ({ essentials, deletions })));
      }),
    );
  };
}
