import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { catchError, defer, finalize, from, of, timeout } from "rxjs";
import { ISSUE_KIND, PR_ROOT_KINDS, isRepositoryRootItem } from "./nip34";

export const REPOSITORY_CACHE_DEADLINE_MS = 3000;
const essentialKinds = [1630, 1631, 1632, 1633, 1985, 1624, 5];

/** Publish one coherent cache read, never roots followed by missing statuses.
 * Cancellation/deadline discards the result; ordinary relay discovery recovers
 * evicted or unavailable data. Cache contents do not prove freshness/completeness.
 */
export function loadRepositoryCache(
  coords: string[],
  read: (filters: Filter[]) => Promise<NostrEvent[]>,
) {
  return defer(() => {
    const controller = new AbortController();
    const readActive = async (filters: Filter[]) => {
      controller.signal.throwIfAborted();
      const result = await read(filters);
      controller.signal.throwIfAborted();
      return result;
    };
    return from(
      (async () => {
        const roots = (
          await readActive([
            { kinds: [ISSUE_KIND, ...PR_ROOT_KINDS], "#a": coords },
          ])
        ).filter((event) => isRepositoryRootItem(event, new Set(coords)));
        if (!roots.length) return [];
        const ids = roots.map((event) => event.id);
        const children = await readActive([
          { kinds: essentialKinds, "#e": ids },
          { kinds: [1619], "#E": ids },
        ]);
        const withdrawals = children.length
          ? await readActive([
              { kinds: [5], "#e": children.map((event) => event.id) },
            ])
          : [];
        // Deletions first, then dependencies, then roots: models must never observe
        // a cached root before its already-known status or withdrawal is restored.
        const events = [
          ...withdrawals,
          ...children.filter((event) => event.kind === 5),
          ...children.filter((event) => event.kind !== 5),
          ...roots,
        ];
        return [...new Map(events.map((event) => [event.id, event])).values()];
      })(),
    ).pipe(finalize(() => controller.abort()));
  }).pipe(
    timeout({ first: REPOSITORY_CACHE_DEADLINE_MS }),
    catchError(() => of([] as NostrEvent[])),
  );
}
