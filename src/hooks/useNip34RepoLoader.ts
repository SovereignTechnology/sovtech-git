import { useEffect, useMemo } from "react";
import { use$ } from "./use$";
import type { RelayGroup } from "applesauce-relay";
import {
  coordsCacheKey,
  roleHistoryCacheKey,
  type RepositoryRoleHistory,
} from "@/lib/nip34";
import { auditTime, distinctUntilChanged, BehaviorSubject, EMPTY } from "rxjs";
import { catchError } from "rxjs/operators";
import { nip34RepoLoader, type Nip34RepoLoaderInputs } from "@/services/nostr";

/**
 * Own the shared issue/PR root fetch once per repository layout.
 * Coordinate and role-history updates feed the existing subscription; only
 * relay-group identity, privacy or loss of all coordinates restarts it.
 * Supplemental outbox coverage and item-detail loading have separate owners.
 */
export function useNip34RepoLoader(
  repoCoords: string | string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
  privateRepository: boolean | undefined,
  roleHistory?: RepositoryRoleHistory,
  cacheRelays: string[] = [],
) {
  // Normalise to a sorted array for consistent filter building and cache keys.
  const coords = useMemo(() => {
    if (!repoCoords) return undefined;
    const arr = Array.isArray(repoCoords) ? repoCoords : [repoCoords];
    return [...arr].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(repoCoords) ? repoCoords.join(",") : repoCoords]);

  const cacheKey = coords ? coordsCacheKey(coords) : "";

  // Structural key: the resolver rebuilds roleHistory on every
  // announcement-graph emission, so identity-based deps would restart the
  // relay subscription (fresh seenIds, full re-fetch) on emissions that did
  // not change role content.
  const roleHistoryKey = useMemo(
    () => roleHistoryCacheKey(roleHistory),
    [roleHistory],
  );

  // Reactive loader inputs anchored on the relay group, which is model-cached
  // per (pubkey, dTag) — so the relay subscription below survives coordinate
  // growth and role-history changes, restarting only when the repository
  // identity changes.
  const inputs$ = useMemo(
    () =>
      new BehaviorSubject<Nip34RepoLoaderInputs>({
        coords: coords ?? [],
        roleHistory,
        cacheRelays,
      }),
    // Intentionally NOT keyed on coords/roleHistory — they are fed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoRelayGroup],
  );
  const cacheRelaysKey = cacheRelays.join(",");
  useEffect(() => {
    if (!coords || coords.length === 0) return;
    inputs$.next({ coords, roleHistory, cacheRelays });
    // Content-keyed deps: pushes happen only when the coordinate set or the
    // role-history content changes; the loader additionally no-ops on
    // unchanged inputs, so re-pushes are free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs$, cacheKey, roleHistoryKey, cacheRelaysKey]);

  // The factory retains seen item IDs across additive updates. Its root
  // subscriptions are released when this owner unsubscribes; per-item work
  // continues to use the shared singleton loaders.
  const cacheState$ = useMemo(
    () => new BehaviorSubject({ loading: false, refreshing: false }),
    // Loading state belongs to this repository owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoRelayGroup],
  );
  const cacheStatus = use$(
    () =>
      cacheState$.pipe(
        auditTime(100),
        distinctUntilChanged(
          (a, b) => a.loading === b.loading && a.refreshing === b.refreshing,
        ),
      ),
    [cacheState$],
  );
  const hasCoords = !!coords && coords.length > 0;
  use$(() => {
    if (!hasCoords || !repoRelayGroup) return undefined;
    return nip34RepoLoader(
      inputs$,
      repoRelayGroup,
      privateRepository,
      (events) => {
        const previous = cacheState$.value;
        cacheState$.next({
          ...previous,
          loading: events === undefined,
        });
      },
      (refreshing) => cacheState$.next({ ...cacheState$.value, refreshing }),
    ).pipe(catchError(() => EMPTY));
  }, [hasCoords, repoRelayGroup, inputs$, privateRepository, cacheState$]);
  return cacheStatus;
}
