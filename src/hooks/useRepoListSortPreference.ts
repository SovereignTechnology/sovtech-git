import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import type { Filter } from "applesauce-core/helpers";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { castTimelineStream } from "applesauce-common/observable";
import {
  combineLatest,
  firstValueFrom,
  from,
  map,
  of,
  shareReplay,
  skip,
  startWith,
  timeout,
} from "rxjs";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import {
  GitWorkshopPreferences,
  PREFERENCES_IDENTIFIER,
  PREFERENCES_KIND,
} from "@/casts/GitWorkshopPreferences";
import { GitWorkshopPreferencesFactory } from "@/factories/GitWorkshopPreferencesFactory";
import { DEFAULT_REPO_LIST_SORT, type RepoListSort } from "@/lib/repoListSort";
import {
  assessMailboxDiscovery,
  isRelayCoverageInFlight,
  mailboxOutboxesObservable,
  meetsBoundedTwoThirdsThreshold,
  waitForCoverageDecision,
} from "@/lib/replaceablePreflightCoverage";
import { normalizeUrl } from "@/lib/url";
import { publish } from "@/services/nostr";
import { cacheRequest } from "@/services/cache";
import { fallbackRelays, lookupRelays } from "@/services/settings";
import { userIdentityCoverage } from "@/services/userIdentityCoverage";
import { accounts } from "@/services/accounts";
import { useRepoListState } from "@/hooks/useRepoListState";

const unique = (relays: readonly string[]) =>
  [...new Set(relays.map(normalizeUrl))].sort();

/** Uses the account-owned identity lease for this exact preference; see docs/replaceable-preflight.md. */
export function useRepoListSortPreference(
  componentId: string | undefined,
  list: "issues" | "prs",
) {
  const account = useActiveAccount();
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const { state: listState, update: updateListState } = useRepoListState(
    componentId,
    list,
  );
  const accountKey = account?.pubkey ?? "guest";
  const [operation, setOperation] = useState<{
    owner: object;
    sort: RepoListSort;
    pending: boolean;
    error?: string;
  }>();
  const running = useRef(false);
  const owner = useMemo(
    () => ({
      account,
      active: false,
    }),
    [account],
  );
  const filter = useMemo<Filter | undefined>(
    () =>
      account
        ? ({
            kinds: [PREFERENCES_KIND],
            authors: [account.pubkey],
            "#d": [PREFERENCES_IDENTIFIER],
          } as Filter)
        : undefined,
    [account],
  );
  const scope$ = useMemo(
    () =>
      account
        ? combineLatest([
            mailboxOutboxesObservable(store, account.pubkey),
            fallbackRelays,
            lookupRelays,
            userIdentityCoverage.changes$.pipe(startWith(undefined)),
          ]).pipe(
            map(([mailboxes, fallback, lookup]) => {
              const outboxes = unique(mailboxes ?? []);
              const backups = unique(fallback).filter(
                (url) => !outboxes.includes(url),
              );
              return {
                coverage: userIdentityCoverage.get(account.pubkey),
                outboxes,
                backups,
                relays: [...outboxes, ...backups],
                discovery: assessMailboxDiscovery(
                  userIdentityCoverage.get(account.pubkey),
                  lookup,
                  mailboxes !== undefined,
                ),
              };
            }),
            shareReplay({ bufferSize: 1, refCount: true }),
          )
        : undefined,
    [account, store],
  );
  useEffect(() => {
    owner.active = true;
    running.current = false;
    return () => {
      owner.active = false;
    };
  }, [owner]);

  const preferences = use$(
    () =>
      filter
        ? store
            .timeline([filter])
            .pipe(castTimelineStream(GitWorkshopPreferences, castStore))
        : of([]),
    [filter, store, castStore],
  );
  let savedSort = DEFAULT_REPO_LIST_SORT;
  let readError: string | undefined;
  try {
    savedSort = preferences?.[0]?.listSort ?? DEFAULT_REPO_LIST_SORT;
  } catch (error) {
    readError =
      error instanceof Error ? error.message : "Could not read saved sorting.";
  }

  const currentOperation = operation?.owner === owner ? operation : undefined;
  const sort = listState.sortByAccount[accountKey] ?? savedSort;
  const save = async (sort: RepoListSort) => {
    if (!account) return;
    if (!scope$ || !filter || running.current) return;
    running.current = true;
    setOperation({ owner, sort, pending: true });
    const assertActive = () => {
      if (!owner.active || accounts.active !== owner.account)
        throw new Error("The active account changed. Please try again.");
    };
    const assess = (scope: Awaited<ReturnType<typeof getScope>>) => {
      const coverage = scope.coverage;
      if (!coverage)
        return {
          met: false,
          possible: owner.active,
          summary: "Waiting for the active account subscription.",
        };
      if (scope.discovery !== "known")
        return {
          met: false,
          possible: scope.discovery === "checking",
          summary: "Your publishing relays could not be established.",
        };
      const enough = (possible: boolean) => {
        const count = (relays: string[]) =>
          relays.filter(
            (url) =>
              coverage.isCovered(url) ||
              (possible && isRelayCoverageInFlight(coverage, url)),
          ).length;
        const outboxes = count(scope.outboxes);
        return scope.outboxes.length === 0
          ? meetsBoundedTwoThirdsThreshold(
              count(scope.backups),
              scope.backups.length,
            )
          : outboxes === 1
            ? count(scope.backups) >= 2
            : outboxes >= 2 &&
              (outboxes >= 3 || outboxes / scope.outboxes.length >= 0.5);
      };
      return {
        met: enough(false),
        possible: enough(true),
        summary:
          "Not enough relays have answered the preferences query. Check your relay connections and retry.",
      };
    };
    const getScope = () => firstValueFrom(scope$);
    try {
      const frozenScope = await waitForCoverageDecision({
        timeoutMs: 5_000,
        getSnapshot: getScope,
        assess,
        changes: () => scope$.pipe(skip(1)),
        error: (assessment) => new Error(assessment.summary),
      });
      if (
        !store.getReplaceable(
          PREFERENCES_KIND,
          account.pubkey,
          PREFERENCES_IDENTIFIER,
        )
      ) {
        const cached = await firstValueFrom(
          from(cacheRequest([filter])).pipe(timeout(1_000)),
        );
        assertActive();
        cached.forEach((event) => store.add(event));
      }
      assertActive();
      const readyScope = await getScope();
      assertActive();
      if (
        !assess(readyScope).met ||
        readyScope.coverage !== frozenScope.coverage ||
        readyScope.relays.join(",") !== frozenScope.relays.join(",")
      )
        throw new Error("Relay coverage changed before signing. Please retry.");
      const previous = store.getReplaceable(
        PREFERENCES_KIND,
        account.pubkey,
        PREFERENCES_IDENTIFIER,
      );
      const data = previous
        ? new GitWorkshopPreferences(previous, castStore).data
        : {};
      const event = await GitWorkshopPreferencesFactory.create(
        previous,
        data,
        sort,
      ).sign(account.signer);
      assertActive();
      const currentScope = await getScope();
      if (
        !assess(currentScope).met ||
        currentScope.coverage !== frozenScope.coverage ||
        currentScope.relays.join(",") !== frozenScope.relays.join(",")
      )
        throw new Error("Relay coverage changed while signing. Please retry.");
      assertActive();
      if (
        store.getReplaceable(
          PREFERENCES_KIND,
          account.pubkey,
          PREFERENCES_IDENTIFIER,
        )?.id !== previous?.id
      ) {
        throw new Error(
          "Your preferences changed on another device while saving. Please retry.",
        );
      }
      await publish(event);
      if (owner.active) setOperation(undefined);
    } catch (error) {
      if (owner.active)
        setOperation({
          owner,
          sort,
          pending: false,
          error:
            error instanceof Error ? error.message : "Could not save sorting.",
        });
    } finally {
      if (owner.active) running.current = false;
    }
  };

  return {
    sort,
    defaultSort: savedSort,
    setSort: (sort: RepoListSort) =>
      updateListState("sortByAccount", {
        ...listState.sortByAccount,
        [accountKey]: sort,
      }),
    makeDefault: () => save(sort),
    pending: currentOperation?.pending ?? false,
    error: currentOperation?.error ?? readError,
    retry: () => save(currentOperation?.sort ?? savedSort),
    signedIn: !!account,
  };
}
