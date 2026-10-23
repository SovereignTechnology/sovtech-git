import { TimelineModel } from "applesauce-core/models";
import { coalesceBursts } from "@/lib/coalesceBursts";
import { combineLatest, of } from "rxjs";
import { auditTime, switchMap, map } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import {
  ISSUE_KIND,
  COMMENT_KIND,
  LEGACY_REPLY_KINDS,
  pubkeyFromCoordinate,
  isRepositoryRootItem,
  buildResolvedIssues,
  type ResolvedIssueLite,
  type ResolveEssentialsOptions,
} from "@/lib/nip34";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";

import { ItemEssentialEventsModel } from "./ItemEssentialEventsModel";

/**
 * IssueListModel — subscribes to issues and their essentials, comment, and
 * zap events in the store and emits a fully-resolved list of ResolvedIssue
 * objects.
 *
 * Reactivity design:
 *   1. issues$ — store.timeline for the root issue events, scoped to coords.
 *   2. auditTime(100) — collapses rapid successive emissions (e.g. 50 issues
 *      arriving at once) into a single emission no more frequently than every
 *      100ms, preventing a stampeding herd of essentials re-subscriptions.
 *   3. switchMap — when the settled issue list changes, tears down the
 *      previous inner subscriptions and creates new ones scoped to the current
 *      set of issue IDs. This is the key correctness guarantee: essentials are
 *      always scoped to #e of the known issue IDs, never unscoped.
 *   4. combineLatest — inside the switchMap, combines essentials + comments +
 *      zaps into a single stream that re-emits whenever any of the three
 *      updates. buildResolvedIssues is called on each emission.
 *
 * Comment counts are 0 until nip34ListLoader fetches comment events into
 * the store. Zap counts are 0 until nip34ThreadItemLoader fetches them.
 * The model reacts to whatever is present — no special casing.
 *
 * Used for both the list page (many issues) and the detail page (one issue,
 * passed as a single-element coord set). PatchListModel is structurally
 * identical with different root kinds.
 *
 * Cache key: the sorted, comma-joined coordinate string (e.g.
 * "30617:abc:repo,30617:def:repo"). Use coordsCacheKey() from nip34.ts.
 * The member set is derived from the coord strings directly via
 * pubkeyFromCoordinate — no BFS needed here, that's done upstream.
 *
 * This model does NOT fetch from relays — pair it with relay subscriptions in
 * useIssues and useNip34ItemLoader that populate the store first.
 *
 * @param coordsCacheKey - Sorted, comma-joined coordinate string (cache key)
 * @param options        - Per-entity-type auth tweaks passed to resolveEssentials
 */
export function IssueListModel(
  coordsCacheKey: string,
  options: ResolveEssentialsOptions = {},
): Model<ResolvedIssueLite[]> {
  return (store) => {
    // Derive the member set from the coord strings. The pubkey is always
    // extractable from the coordinate itself ("30617:<pubkey>:<dTag>"), so the
    // set is fully known without any relay fetches.
    const coords = coordsCacheKey ? coordsCacheKey.split(",") : [];
    const memberSet = new Set<string>(
      coords.flatMap((c) => {
        const pk = pubkeyFromCoordinate(c);
        return pk ? [pk] : [];
      }),
    );
    const coordinateSet = new Set(coords);

    const issueFilter: Filter[] = [
      { kinds: [ISSUE_KIND], "#a": coords } as Filter,
    ];

    return store.timeline(issueFilter).pipe(
      // Collapse rapid successive emissions — no more than one re-subscription
      // per 100ms window regardless of how many issue events arrive at once.
      auditTime(100),

      switchMap((issueEvents) => {
        const events = (issueEvents as NostrEvent[]).filter((event) =>
          isRepositoryRootItem(event, coordinateSet),
        );
        if (events.length === 0) return of([] as ResolvedIssueLite[]);

        const ids = events.map((e) => e.id);

        // All inner streams are scoped to the current issue IDs.
        // The outer list model is shared. These changing ID sets belong only
        // to this snapshot: caching them would keep obsolete queries active
        // throughout the store's model keep-warm window.
        const essentials$ = ItemEssentialEventsModel(ids.sort().join(","))(
          store,
        );
        const comments$ = TimelineModel([
          { kinds: [COMMENT_KIND], "#E": ids } as Filter,
        ])(store);
        const legacyReplies$ = TimelineModel([
          { kinds: [...LEGACY_REPLY_KINDS], "#e": ids } as Filter,
        ])(store);
        const zaps$ = TimelineModel([{ kinds: [9735], "#e": ids } as Filter])(
          store,
        );

        return combineLatest([
          essentials$,
          comments$,
          legacyReplies$,
          zaps$,
        ]).pipe(
          // Keep the latest snapshot without rebuilding the entire list per event.
          coalesceBursts(),
          map(
            ([essentialEvents, commentEvents, legacyReplyEvents, zapEvents]) =>
              buildResolvedIssues(
                events,
                essentialEvents.essentials,
                [
                  ...(commentEvents as NostrEvent[]),
                  ...(legacyReplyEvents as NostrEvent[]),
                ],
                zapEvents as NostrEvent[],
                memberSet,
                {
                  ...options,
                  essentialDeletionEvents: [
                    ...(options.essentialDeletionEvents ?? []),
                    ...essentialEvents.deletions,
                  ],
                },
              ),
          ),
        );
      }),
    );
  };
}
