import { map, shareReplay, type Observable } from "rxjs";
import type { NostrEvent } from "nostr-tools";

/** Deletion requests indexed by the exact event IDs they reference. */
export type DeletionEvidenceIndex = ReadonlyMap<string, readonly NostrEvent[]>;

const indexes = new WeakMap<
  Observable<NostrEvent[]>,
  Observable<DeletionEvidenceIndex>
>();

/** One shared indexing pass per evidence update, rather than one per item. */
export function indexedDeletionEvidence(
  source: Observable<NostrEvent[]>,
): Observable<DeletionEvidenceIndex> {
  const cached = indexes.get(source);
  if (cached) return cached;
  const indexed = source.pipe(
    map((events): DeletionEvidenceIndex => {
      const byTarget = new Map<string, NostrEvent[]>();
      for (const event of events) {
        if (event.kind !== 5) continue;
        for (const id of new Set(
          event.tags.filter(([name]) => name === "e").map(([, id]) => id),
        )) {
          const requests = byTarget.get(id) ?? [];
          requests.push(event);
          byTarget.set(id, requests);
        }
      }
      return byTarget;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
  indexes.set(source, indexed);
  return indexed;
}

export function selectDeletionEvidence(
  index: DeletionEvidenceIndex,
  ids: string[],
): NostrEvent[] {
  const selected = new Map<string, NostrEvent>();
  for (const id of ids) {
    for (const event of index.get(id) ?? []) selected.set(event.id, event);
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}
