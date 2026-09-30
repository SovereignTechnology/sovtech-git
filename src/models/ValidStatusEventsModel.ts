import { combineLatest, of, type Observable } from "rxjs";
import { map, startWith, switchMap } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import type { NostrEvent } from "nostr-tools";
import { getNip10References } from "applesauce-common/helpers";
import { hasNameValueTag } from "applesauce-core/helpers";
import { ISSUE_KIND, PATCH_KIND, PR_KIND, STATUS_KINDS } from "@/lib/nip34";
import { ItemEssentialsModel } from "./ItemEssentialsModel";

/** Stable model key containing only the roots targeted by status events. */
export function statusRootsKey(events: NostrEvent[]): string {
  return [
    ...new Set(
      events.flatMap((event) => {
        if (!(STATUS_KINDS as readonly number[]).includes(event.kind))
          return [];
        const root = getNip10References(event).root?.e?.id;
        return root ? [root] : [];
      }),
    ),
  ]
    .sort()
    .join(",");
}

/** Validate before grouping/counting; missing roots or authority grant nothing. */
export function ValidStatusEventsModel(
  rootsKey: string,
  deletionEvents?: Observable<NostrEvent[]>,
): Model<ReadonlySet<string>> {
  return (store) => {
    const roots = rootsKey.split(",").filter(Boolean);
    if (roots.length === 0) return of(new Set<string>());
    return combineLatest(
      roots.map((id) =>
        store.event(id).pipe(
          switchMap((root) => {
            if (
              !root ||
              !(
                root.kind === ISSUE_KIND ||
                root.kind === PR_KIND ||
                (root.kind === PATCH_KIND &&
                  hasNameValueTag(root, "t", "root") &&
                  !hasNameValueTag(root, "t", "root-revision") &&
                  !hasNameValueTag(root, "t", "revision-root"))
              )
            ) {
              return of(new Set<string>());
            }
            return store
              .model(ItemEssentialsModel, root, deletionEvents)
              .pipe(
                map((item) => item.validStatusEventIds ?? new Set<string>()),
              );
          }),
          startWith(new Set<string>()),
        ),
      ),
    ).pipe(map((sets) => new Set(sets.flatMap((ids) => [...ids]))));
  };
}

ValidStatusEventsModel.getKey = (
  rootsKey: string,
  deletionEvents?: Observable<NostrEvent[]>,
) =>
  JSON.stringify([
    rootsKey,
    deletionEvents ? "deletion-aware" : "current-only",
  ]);
