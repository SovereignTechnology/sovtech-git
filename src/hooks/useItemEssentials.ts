import { of } from "rxjs";
import { distinctUntilChanged, map, switchMap } from "rxjs/operators";
import type { NostrEvent } from "nostr-tools";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import { ItemEssentialsModel } from "@/models/ItemEssentialsModel";
import { RepositoryRelayGroup } from "@/models/RepositoryRelayGroup";
import { getRootRepositoryCoordinates, parseRepoCoordinate } from "@/lib/nip34";
import { deletionEvents$, nip34ItemEssentialsLoader } from "@/services/nostr";
import { gitIndexRelays } from "@/services/settings";

/** Resolve off-page items using the same authority and status rules as details. */
export function useItemEssentials(
  root: NostrEvent | undefined,
  relayHints: string[] = [],
) {
  const store = useEventStore();
  const pointer = parseRepoCoordinate(
    root && getRootRepositoryCoordinates(root)[0],
  );
  const relayHintsKey = [...relayHints].sort().join(",");

  use$(() => {
    if (!root) return undefined;
    const relays$ = pointer
      ? store
          .model(RepositoryRelayGroup, pointer.pubkey, pointer.identifier)
          .pipe(map((group) => group.relays.map((relay) => relay.url)))
      : of([] as string[]);
    return relays$.pipe(
      map((relays) =>
        [
          ...new Set([...relays, ...relayHints, ...gitIndexRelays.getValue()]),
        ].sort(),
      ),
      distinctUntilChanged((a, b) => a.join(",") === b.join(",")),
      switchMap((relays) => nip34ItemEssentialsLoader(root.id, relays)),
    );
  }, [root?.id, pointer?.pubkey, pointer?.identifier, relayHintsKey, store]);

  return use$(
    () =>
      root
        ? store.model(ItemEssentialsModel, root, deletionEvents$)
        : undefined,
    [root?.id, store],
  );
}
