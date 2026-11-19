import { combineLatest, of, type Observable } from "rxjs";
import { map, startWith } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import type { NostrEvent } from "nostr-tools";
import {
  getRootRepositoryCoordinates,
  parseRepoCoordinate,
  resolveItemEssentials,
  type ResolvedItemEssentials,
  type ResolvedRepo,
} from "@/lib/nip34";
import { RepositoryModel } from "./RepositoryModel";
import { ItemEssentialEventsModel } from "./ItemEssentialEventsModel";

/** Shared status/subject resolution for previews, notifications and activity. */
export function ItemEssentialsModel(
  root: NostrEvent,
  deletionEvents?: Observable<NostrEvent[]>,
): Model<ResolvedItemEssentials> {
  return (store) => {
    const coordinate = getRootRepositoryCoordinates(root)[0];
    const pointer = coordinate ? parseRepoCoordinate(coordinate) : undefined;
    const repository$ = pointer
      ? (
          store.model(
            RepositoryModel,
            pointer.pubkey,
            pointer.identifier,
            deletionEvents,
          ) as Observable<ResolvedRepo | undefined>
        ).pipe(startWith(undefined))
      : of(undefined);
    return combineLatest([
      store.model(ItemEssentialEventsModel, root.id),
      repository$,
      deletionEvents ?? of([] as NostrEvent[]),
    ]).pipe(
      map(([{ essentials, deletions }, repo, evidence]) => {
        // Previews can retain the root after the EventStore removes it, so
        // include durable deletion evidence as well as live store events.
        const rootDeletions = evidence.filter((event) =>
          event.tags.some(([name, id]) => name === "e" && id === root.id),
        );
        return resolveItemEssentials(
          root,
          [...essentials, ...rootDeletions],
          [],
          [],
          new Set(repo?.confirmedMembers ?? []),
          {
            roleHistory: repo?.roleHistory,
            essentialDeletionEvents: [...deletions, ...evidence],
          },
        );
      }),
    );
  };
}

ItemEssentialsModel.getKey = (
  root: NostrEvent,
  deletionEvents?: Observable<NostrEvent[]>,
) =>
  JSON.stringify([root.id, deletionEvents ? "deletion-aware" : "current-only"]);
