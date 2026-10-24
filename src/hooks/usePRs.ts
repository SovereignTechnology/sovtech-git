import type { IEventStore } from "applesauce-core";
import { useMemo } from "react";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import {
  coordsCacheKey,
  roleHistoryCacheKey,
  type RepositoryRoleHistory,
  type ResolvedPRLite,
} from "@/lib/nip34";
import { PRListModel } from "@/models/PRListModel";
import type { Observable } from "rxjs";

// ---------------------------------------------------------------------------
// Bulk hook (repo PR list)
// ---------------------------------------------------------------------------

/**
 * Resolve repository PRs and root patches from the store.
 *
 * RepoLayout owns the shared relay fetch through useNip34RepoLoader.
 * Uses PRListModel for kinds [1617, 1618], parallel to useIssues.
 */
export function usePRs(
  repoCoords: string | string[] | undefined,
  roleHistory?: RepositoryRoleHistory,
  view?: IEventStore,
): ResolvedPRLite[] | undefined {
  const canonical = useEventStore();
  const store = view ?? canonical;

  const coords = useMemo(() => {
    if (!repoCoords) return undefined;
    const arr = Array.isArray(repoCoords) ? repoCoords : [repoCoords];
    return [...arr].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(repoCoords) ? repoCoords.join(",") : repoCoords]);

  const cacheKey = coords ? coordsCacheKey(coords) : "";

  // Rebuilt role-history objects only change this model when content changes.
  const roleHistoryKey = useMemo(
    () => roleHistoryCacheKey(roleHistory),
    [roleHistory],
  );

  // Subscribe to the model — cached by the store, shared across components.
  return use$(() => {
    if (!coords || coords.length === 0) return undefined;
    return store.model(
      PRListModel,
      cacheKey,
      roleHistory,
    ) as unknown as Observable<ResolvedPRLite[]>;
  }, [cacheKey, roleHistoryKey, store]);
}
