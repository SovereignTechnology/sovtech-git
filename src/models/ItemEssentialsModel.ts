import { combineLatest, of, type Observable } from "rxjs";
import { distinctUntilChanged, map, startWith } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import type { NostrEvent } from "nostr-tools";
import {
  getRootRepositoryCoordinates,
  parseRepoCoordinate,
  resolveItemEssentials,
  roleHistoryCacheKey,
  type RepositoryRoleHistory,
  type ResolvedItemEssentials,
  type ResolvedRepo,
} from "@/lib/nip34";
import {
  indexedDeletionEvidence,
  selectDeletionEvidence,
  type DeletionEvidenceIndex,
} from "@/lib/deletionEvidenceIndex";
import { RepositoryModel } from "./RepositoryModel";
import { ItemEssentialEventsModel } from "./ItemEssentialEventsModel";

interface ItemAuthority {
  members: Set<string>;
  roleHistory?: RepositoryRoleHistory;
  key: string;
}
const unresolvedAuthority: ItemAuthority = {
  members: new Set(),
  key: "unresolved",
};
const authoritySnapshots = new WeakMap<ResolvedRepo, ItemAuthority>();

/** Compute a signature once per shared repository snapshot, not once per item. */
function itemAuthority(repo: ResolvedRepo | undefined): ItemAuthority {
  if (!repo) return unresolvedAuthority;
  const cached = authoritySnapshots.get(repo);
  if (cached) return cached;
  const authority = {
    members: new Set(repo.confirmedMembers),
    roleHistory: repo.roleHistory,
    key: JSON.stringify([
      [...repo.confirmedMembers].sort(),
      roleHistoryCacheKey(repo.roleHistory),
    ]),
  };
  authoritySnapshots.set(repo, authority);
  return authority;
}

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
    const authority$ = repository$.pipe(
      map(itemAuthority),
      distinctUntilChanged((a, b) => a.key === b.key),
    );
    const indexedEvidence$ = deletionEvents
      ? indexedDeletionEvidence(deletionEvents)
      : of(new Map<string, readonly NostrEvent[]>() as DeletionEvidenceIndex);
    const itemEvents$ = combineLatest([
      store.model(ItemEssentialEventsModel, root.id),
      indexedEvidence$,
    ]).pipe(
      map(([snapshot, index]) => ({
        ...snapshot,
        evidence: selectDeletionEvidence(index, [
          root.id,
          ...snapshot.essentials.map((event) => event.id),
        ]),
      })),
      distinctUntilChanged(
        (a, b) =>
          a.essentials === b.essentials &&
          a.deletions === b.deletions &&
          a.evidence.length === b.evidence.length &&
          a.evidence.every((event, i) => event.id === b.evidence[i].id),
      ),
    );
    return combineLatest([itemEvents$, authority$]).pipe(
      map(([{ essentials, deletions, evidence }, authority]) => {
        const rootDeletions = evidence.filter((event) =>
          event.tags.some(([name, id]) => name === "e" && id === root.id),
        );
        return resolveItemEssentials(
          root,
          [...essentials, ...rootDeletions],
          [],
          [],
          authority.members,
          {
            roleHistory: authority.roleHistory,
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
