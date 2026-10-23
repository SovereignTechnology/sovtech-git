import { useMemo } from "react";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import {
  coordsCacheKey,
  roleHistoryCacheKey,
  type RepositoryRoleHistory,
  type ResolvedIssueLite,
} from "@/lib/nip34";
import { IssueListModel } from "@/models/IssueListModel";
import type { Observable } from "rxjs";

// ---------------------------------------------------------------------------
// Bulk hook (repo issue list)
// ---------------------------------------------------------------------------

/**
 * Resolve repository issues from the store; RepoLayout owns relay loading.
 *
 * Accepts either a single coordinate string or an array of coordinate strings
 * (one per maintainer in the chain). Passing all maintainer coordinates
 * ensures issues tagged against any co-maintainer's announcement are included.
 *
 * Returns a flat list of ResolvedIssueLite objects — each combining the raw
 * issue event with its current status, labels, and subject from essentials
 * events. Consumers can filter and display directly without holding separate
 * maps.
 *
 * The resolved list is backed by IssueListModel, which is cached by the store
 * keyed on the sorted coordinate string. Multiple components subscribing to
 * the same repo share one model instance and one set of store subscriptions.
 *
 * Reads events from both the base repository and supplemental relay owners.
 * Call useNip34RepoLoader once at the page boundary to fetch their roots.
 *
 * @param repoCoords - Repository presentation coordinates
 * @param roleHistory - Role history for resolving item essentials
 */
export function useIssues(
  repoCoords: string | string[] | undefined,
  roleHistory?: RepositoryRoleHistory,
): ResolvedIssueLite[] | undefined {
  const store = useEventStore();

  // Normalise to a sorted array for consistent filter building and cache keys.
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
    return store.model(IssueListModel, cacheKey, {
      roleHistory,
    }) as unknown as Observable<ResolvedIssueLite[]>;
  }, [cacheKey, roleHistoryKey, store]);
}
