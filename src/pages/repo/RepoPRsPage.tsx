import { RepositorySourceBadge } from "@/components/RepositorySourceBadge";
import { RepoListToolbar } from "@/components/RepoListToolbar";
import { useRepoListSortPreference } from "@/hooks/useRepoListSortPreference";
import { compareRepoItems } from "@/lib/repoListSort";
import { REPO_LIST_DEFAULTS, useRepoListState } from "@/hooks/useRepoListState";
import { useMemo } from "react";
import type { IFuseOptions } from "fuse.js";
import { Link } from "react-router-dom";
import {
  eventIdMatchesSearch,
  eventIdToNevent,
  searchQueryToPubkey,
} from "@/lib/routeUtils";
import { compactNumber } from "@/lib/utils";
import { useSeoMeta } from "@unhead/react";
import { useProfile } from "@/hooks/useProfile";
import { formatDistanceToNow } from "date-fns";
import { useRepoContext } from "./RepoContext";
import { UserAvatar, UserName } from "@/components/UserAvatar";
import { StatusIcon } from "@/components/StatusIcon";
import { StatusTabs } from "@/components/StatusTabs";
import { LabelBadge } from "@/components/LabelBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { MultiSelect } from "@/components/ui/multi-select";
import type { MultiSelectOption } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MessageCircle, Users, Zap, GitBranch, ListFilter } from "lucide-react";
import {
  hasAcceptedRepositoryReference,
  type IssueStatus,
  type ResolvedPRLite,
  type ResolvedRepo,
  type PRItemType,
} from "@/lib/nip34";
import { useCIForPR, useRepoCI } from "@/hooks/useCI";
import { CIStatusTrustIcon } from "@/components/ci/CIStatusTrustIcon";
import { summarizeRuns } from "@/lib/ci";
import { useRepositoryCITrust } from "@/hooks/useRepositoryCITrust";
import type { CIServiceControl } from "@/casts/CICoordinator";
import {
  getCIRunTrustResolution,
  summarizeCIRunTrust,
  type CITrustContextState,
} from "@/lib/ciTrustContext";
import {
  RepoItemAttributionIndicator,
  RepoItemAttributionWarning,
} from "@/components/RepoItemAttributionWarning";
import { useInferredPRParents } from "@/hooks/useInferredPRParents";
import type { InferredPRParentRelation } from "@/lib/inferredPRParents";
import {
  getInferredPRChildren,
  getInferredPRStackLayer,
} from "@/lib/inferredPRParents";
import { useGitPool } from "@/hooks/useGitPool";
import { useFuzzySearch } from "@/hooks/useFuzzySearch";

const TYPE_OPTIONS: MultiSelectOption[] = [
  { value: "pr", label: "Pull Requests" },
  { value: "patch", label: "Patches" },
];

const DEFAULT_STATUS_FILTER = REPO_LIST_DEFAULTS.prs.statusFilter;
const PR_SEARCH_OPTIONS: IFuseOptions<ResolvedPRLite> = {
  keys: [
    { name: "currentSubject", weight: 4 },
    { name: "originalSubject", weight: 2 },
    { name: "targetBranch", weight: 2 },
    { name: "content", weight: 1 },
  ],
  threshold: 0.35,
  ignoreDiacritics: true,
  useTokenSearch: true,
  tokenMatch: "all",
};

export default function RepoPRsPage() {
  const { pubkey, repoId, resolved, prs, basePath, repoState, cloneUrls } =
    useRepoContext();
  const repo = resolved?.repo;
  const sorting = useRepoListSortPreference(repo?.componentId, "prs");
  const repoOwnerProfile = useProfile(pubkey);
  const { pool: gitPool, poolState: gitPoolState } = useGitPool(cloneUrls, {
    private: repo?.isPrivate,
  });
  const inferredParents = useInferredPRParents(
    repo?.confirmedMemberCoordinates,
    gitPool,
    gitPoolState,
    repoState,
    prs,
    repo?.roleHistory,
  );
  const ciRuns = useRepoCI(
    repo?.confirmedMaintainerCoordinates,
    repo?.selectedCoordinate,
  );
  const { coordinatorState, trust } = useRepositoryCITrust(repo, ciRuns);

  const {
    state: filters,
    update: updateFilter,
    reset: clearFilters,
  } = useRepoListState(repo?.componentId, "prs");
  const {
    statusFilter,
    labelFilter,
    authorFilter,
    searchQuery,
    typeFilter,
    targetBranchFilter,
  } = filters;

  const setStatusFilter = (value: typeof filters.statusFilter) =>
    updateFilter("statusFilter", value);
  const setLabelFilter = (value: typeof filters.labelFilter) =>
    updateFilter("labelFilter", value);
  const setAuthorFilter = (value: typeof filters.authorFilter) =>
    updateFilter("authorFilter", value);
  const setSearchQuery = (value: typeof filters.searchQuery) =>
    updateFilter("searchQuery", value);
  const setTypeFilter = (value: typeof filters.typeFilter) =>
    updateFilter("typeFilter", value);
  const setTargetBranchFilter = (value: typeof filters.targetBranchFilter) =>
    updateFilter("targetBranchFilter", value);

  // Status counts describe only work addressed to the accepted repository.
  const { statusCounts, unconfirmedStatusCounts } = useMemo(() => {
    const counts: Record<IssueStatus, number> = {
      open: 0,
      draft: 0,
      resolved: 0,
      closed: 0,
      deleted: 0,
    };
    const unconfirmedCounts: Record<IssueStatus, number> = {
      open: 0,
      draft: 0,
      resolved: 0,
      closed: 0,
      deleted: 0,
    };
    if (prs && repo) {
      for (const pr of prs) {
        if (hasAcceptedRepositoryReference(pr.repoCoords, repo)) {
          counts[pr.status]++;
        } else {
          unconfirmedCounts[pr.status]++;
        }
      }
    }
    return {
      statusCounts: counts,
      unconfirmedStatusCounts: unconfirmedCounts,
    };
  }, [prs, repo]);

  // Collect all unique labels and authors from resolved PRs.
  const { allLabels, allAuthors, nonDefaultTargetBranches } = useMemo(() => {
    if (!prs)
      return {
        allLabels: [],
        allAuthors: [],
        nonDefaultTargetBranches: [],
      };
    const labels = new Set<string>();
    const authors = new Set<string>();
    const targetBranches = new Set<string>();
    for (const pr of prs) {
      pr.labels.forEach((l) => labels.add(l));
      authors.add(pr.pubkey);
      if (pr.targetBranch) targetBranches.add(pr.targetBranch);
    }
    return {
      allLabels: Array.from(labels).sort(),
      allAuthors: Array.from(authors),
      nonDefaultTargetBranches: Array.from(targetBranches).sort(),
    };
  }, [prs]);

  const labelOptions: MultiSelectOption[] = allLabels.map((l) => ({
    value: l,
    label: l,
  }));

  // Pubkey queries select an author; ordinary queries use fuzzy text search.
  const searchPubkey = useMemo(
    () => searchQueryToPubkey(searchQuery),
    [searchQuery],
  );

  const facetFilteredPRs = useMemo(
    () =>
      prs
        ?.filter(
          (pr) =>
            (statusFilter.length === 0 || statusFilter.includes(pr.status)) &&
            (typeFilter.length === 0 || typeFilter.includes(pr.itemType)) &&
            !(
              labelFilter.length > 0 &&
              !labelFilter.some((label) => pr.labels.includes(label))
            ) &&
            (!authorFilter || pr.pubkey === authorFilter) &&
            (targetBranchFilter === null ||
              (targetBranchFilter === ""
                ? !pr.targetBranch
                : pr.targetBranch === targetBranchFilter)),
        )
        .sort(compareRepoItems(sorting.sort)),
    [
      prs,
      statusFilter,
      typeFilter,
      labelFilter,
      authorFilter,
      targetBranchFilter,
      sorting.sort,
    ],
  );
  const fuzzyPRs = useFuzzySearch(
    facetFilteredPRs,
    searchPubkey ? "" : searchQuery,
    PR_SEARCH_OPTIONS,
  );

  // Exact event IDs remain authoritative and can bypass active facets.
  const { filteredPRs, idMatchesOutsideFilters } = useMemo(() => {
    if (!prs || !fuzzyPRs) {
      return { filteredPRs: undefined, idMatchesOutsideFilters: 0 };
    }

    const facetIds = new Set(facetFilteredPRs?.map((pr) => pr.id));
    const idMatches = prs.filter((pr) =>
      eventIdMatchesSearch(pr.id, searchQuery),
    );
    const idMatchIds = new Set(idMatches.map((pr) => pr.id));

    return {
      filteredPRs: [
        ...idMatches,
        ...fuzzyPRs.filter(
          (pr) =>
            !idMatchIds.has(pr.id) &&
            (!searchPubkey || pr.pubkey === searchPubkey),
        ),
      ],
      idMatchesOutsideFilters: idMatches.filter((pr) => !facetIds.has(pr.id))
        .length,
    };
  }, [prs, facetFilteredPRs, fuzzyPRs, searchQuery, searchPubkey]);

  const { visibleAcceptedItems, visibleUnconfirmedItems } = useMemo(() => {
    if (!filteredPRs || !repo) {
      return { visibleAcceptedItems: [], visibleUnconfirmedItems: [] };
    }
    const accepted: ResolvedPRLite[] = [];
    const unconfirmed: ResolvedPRLite[] = [];
    for (const pr of filteredPRs) {
      if (hasAcceptedRepositoryReference(pr.repoCoords, repo)) {
        accepted.push(pr);
      } else {
        unconfirmed.push(pr);
      }
    }
    return {
      visibleAcceptedItems: accepted,
      visibleUnconfirmedItems: unconfirmed,
    };
  }, [filteredPRs, repo]);

  // "Active" means filters differ from the default state
  const hasActiveFilters =
    statusFilter.length !== DEFAULT_STATUS_FILTER.length ||
    !DEFAULT_STATUS_FILTER.every((s) => statusFilter.includes(s)) ||
    typeFilter.length > 0 ||
    labelFilter.length > 0 ||
    !!authorFilter ||
    targetBranchFilter !== null ||
    searchQuery.trim().length > 0;

  useSeoMeta({
    title: repo ? `PRs - ${repo.name} - ngit` : "Pull Requests - ngit",
    description:
      repo?.description ?? "Browse pull requests for this repository",
    ogImage: repoOwnerProfile?.picture ?? "/og-image.png",
    ogImageAlt: repo?.name ?? repoId,
    twitterCard: repoOwnerProfile?.picture ? "summary" : "summary_large_image",
  });

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6">
      <RepoListToolbar
        list="prs"
        sorting={sorting}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searching={!!searchQuery.trim() && !searchPubkey}
        labelOptions={labelOptions}
        labelFilter={labelFilter}
        setLabelFilter={setLabelFilter}
        authors={allAuthors}
        authorFilter={authorFilter}
        setAuthorFilter={setAuthorFilter}
        hasActiveFilters={hasActiveFilters}
        onReset={clearFilters}
        beforeFilters={
          <MultiSelect
            options={TYPE_OPTIONS}
            selected={typeFilter}
            onChange={(v) => setTypeFilter(v as PRItemType[])}
            placeholder="Type"
            icon={<ListFilter aria-hidden="true" className="h-4 w-4" />}
            className="w-[140px]"
          />
        }
      >
        {nonDefaultTargetBranches.length > 0 && (
          <Select
            value={
              targetBranchFilter === null
                ? "__all__"
                : targetBranchFilter === ""
                  ? "__default__"
                  : `branch:${targetBranchFilter}`
            }
            onValueChange={(value) =>
              setTargetBranchFilter(
                value === "__all__"
                  ? null
                  : value === "__default__"
                    ? ""
                    : value.slice("branch:".length),
              )
            }
          >
            <SelectTrigger
              aria-label="Filter by target branch"
              className="w-[168px] h-9 gap-2 text-sm"
            >
              <GitBranch
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 text-left truncate">
                <SelectValue placeholder="Target branch" />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All target branches</SelectItem>
              <SelectItem value="__default__">
                {repoState?.headBranch
                  ? `Default (${repoState.headBranch})`
                  : "Default branch"}
              </SelectItem>
              {nonDefaultTargetBranches.map((branch) => (
                <SelectItem key={branch} value={`branch:${branch}`}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </RepoListToolbar>

      {idMatchesOutsideFilters > 0 && (
        <p
          role="status"
          className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
        >
          Showing {idMatchesOutsideFilters} pull request
          {idMatchesOutsideFilters === 1 ? "" : "s"} outside your current
          filters.
        </p>
      )}

      {/* Bordered container with status tabs header + list */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Header bar: status tabs */}
        <div className="flex items-center bg-muted/40 px-3 py-1.5 overflow-x-auto">
          <StatusTabs
            counts={statusCounts}
            secondaryCounts={unconfirmedStatusCounts}
            selected={statusFilter}
            onChange={(v) => setStatusFilter(v as IssueStatus[])}
            variant="pr"
            className="border-b-0 pb-0 mb-0 flex-1"
          />
        </div>

        {/* PR list */}
        {!filteredPRs ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <PRSkeleton key={i} />
            ))}
          </ul>
        ) : visibleAcceptedItems.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-muted-foreground">
              {hasActiveFilters ? "No PRs match your filters" : "No PRs yet"}
            </p>
            <p className="text-muted-foreground/60 text-sm mt-1">
              {hasActiveFilters
                ? "Try adjusting your filters"
                : "PRs and patches sent to this repository will appear here"}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visibleAcceptedItems.map((pr) => (
              <PRRow
                key={pr.id}
                pr={pr}
                repoPath={basePath}
                repoRelays={repo?.relays ?? []}
                repo={repo}
                ciTrust={trust}
                ciServiceControls={coordinatorState?.serviceControls}
                inferredParent={inferredParents?.get(pr.id)}
                stackLayer={
                  inferredParents
                    ? getInferredPRStackLayer(inferredParents, pr.id)
                    : undefined
                }
                hasStackBranches={
                  (inferredParents
                    ? getInferredPRChildren(inferredParents, pr.id).length
                    : 0) > 1
                }
              />
            ))}
          </ul>
        )}
      </div>

      {repo && visibleUnconfirmedItems.length > 0 && (
        <section className="mt-6">
          <RepoItemAttributionWarning
            repo={repo}
            repoCoords={visibleUnconfirmedItems.flatMap((pr) => pr.repoCoords)}
            itemLabel="pull request or patch"
            pageSuffix="/prs"
            count={visibleUnconfirmedItems.length}
            className="rounded-b-none shadow-none"
          />
          <div className="overflow-hidden rounded-b-lg border border-t-0 border-amber-500/40">
            <ul className="divide-y divide-border">
              {visibleUnconfirmedItems.map((pr) => (
                <PRRow
                  key={pr.id}
                  pr={pr}
                  repoPath={basePath}
                  repoRelays={repo.relays}
                  repo={repo}
                  ciTrust={trust}
                  ciServiceControls={coordinatorState?.serviceControls}
                  inferredParent={inferredParents?.get(pr.id)}
                  stackLayer={
                    inferredParents
                      ? getInferredPRStackLayer(inferredParents, pr.id)
                      : undefined
                  }
                  hasStackBranches={
                    (inferredParents
                      ? getInferredPRChildren(inferredParents, pr.id).length
                      : 0) > 1
                  }
                />
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

function PRRow({
  pr,
  repoPath,
  repoRelays,
  repo,
  ciTrust,
  ciServiceControls = [],
  inferredParent,
  stackLayer,
  hasStackBranches,
}: {
  pr: ResolvedPRLite;
  repoPath: string;
  repoRelays: string[];
  repo: ResolvedRepo | undefined;
  ciTrust?: CITrustContextState;
  ciServiceControls?: readonly CIServiceControl[];
  inferredParent: InferredPRParentRelation | undefined;
  stackLayer: { position: number; size: number } | undefined;
  hasStackBranches: boolean;
}) {
  const lastActive = formatDistanceToNow(new Date(pr.lastActivityAt * 1000), {
    addSuffix: true,
  });

  // CI check rollup for the most recent commit with CI activity. Store-read
  // only — kind:9842 results ride along with the #E comments loader and
  // kind:9841 running markers with the repo-level #a meta subscription.
  const ci = useCIForPR(pr.id);
  const trustResolution = summarizeCIRunTrust(
    (ci?.currentRuns ?? []).map((run) =>
      getCIRunTrustResolution(
        ciTrust,
        run,
        repo?.confirmedMaintainers ?? [],
        ciServiceControls,
      ),
    ),
  );

  const nevent = eventIdToNevent(pr.id, repoRelays.slice(0, 1));
  const needsAttributionCheck =
    repo !== undefined && !hasAcceptedRepositoryReference(pr.repoCoords, repo);
  const hasActivityCounts =
    pr.commentCount > 0 || pr.zapTotal > 0 || pr.participantCount > 1;

  return (
    <li className="group flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40">
      <Link
        to={`${repoPath}/prs/${nevent}`}
        className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`Open ${pr.itemType === "patch" ? "patch" : "pull request"}: ${pr.currentSubject}`}
      >
        {/* Status icon — variant reflects PR vs patch */}
        <StatusIcon
          status={pr.status}
          variant={pr.itemType === "patch" ? "patch" : "pr"}
          className="mt-0.5"
        />
      </Link>

      {/* Title + metadata */}
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <Link
              to={`${repoPath}/prs/${nevent}`}
              className="min-w-0 line-clamp-1 font-medium text-foreground transition-colors group-hover:text-pink-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:group-hover:text-pink-400"
            >
              {pr.currentSubject}
            </Link>
            <RepositorySourceBadge eventId={pr.id} />
            {ci?.status && (
              <CIStatusTrustIcon
                status={ci.status}
                resolution={trustResolution}
                statusSummary={summarizeRuns(ci.currentRuns)}
                className="h-3.5 w-3.5"
                align="start"
              />
            )}
          </div>
          {(stackLayer ||
            hasStackBranches ||
            inferredParent?.status === "ambiguous") && (
            <span
              title={
                inferredParent?.status === "ambiguous"
                  ? "Inferred stack parent is ambiguous"
                  : hasStackBranches
                    ? "Inferred stack branches"
                    : stackLayer
                      ? `Inferred stack: layer ${stackLayer.position} of ${stackLayer.size}`
                      : "Inferred stack"
              }
              className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
            >
              <GitBranch className="h-3 w-3" />
              {inferredParent?.status === "ambiguous"
                ? "Stack?"
                : hasStackBranches
                  ? "Stack"
                  : stackLayer
                    ? `${stackLayer.position}/${stackLayer.size}`
                    : "Stack"}
            </span>
          )}
          {pr.targetBranch && (
            <span
              title={`Targets non-default branch ${pr.targetBranch}`}
              aria-label={`Targets branch ${pr.targetBranch}`}
              className="inline-flex min-w-0 shrink items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              <GitBranch className="h-3 w-3 shrink-0" />
              <span aria-hidden="true" className="truncate">
                → {pr.targetBranch}
              </span>
            </span>
          )}
          {pr.labels.map((label) => (
            <LabelBadge
              key={label}
              label={label}
              className="text-[10px] py-0 px-1.5 h-[18px]"
            />
          ))}
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
          <code className="font-mono text-[10px] text-muted-foreground/80">
            #{pr.id.slice(0, 8)}
          </code>
          <span className="text-muted-foreground/40">&middot;</span>
          <span>active {lastActive}</span>
          <span className="text-muted-foreground/40">&middot;</span>
          <UserAvatar
            pubkey={pr.pubkey}
            size="sm"
            className="h-4 w-4 text-[8px]"
          />
          <UserName
            pubkey={pr.pubkey}
            className="text-xs font-normal text-muted-foreground"
          />
        </div>
      </div>

      {/* Comment, zap & participant counts — right-aligned */}
      {hasActivityCounts && (
        <Link
          to={`${repoPath}/prs/${nevent}`}
          className="flex shrink-0 items-center gap-3 self-center rounded text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${pr.currentSubject}`}
        >
          {pr.commentCount > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <MessageCircle className="h-3 w-3" />
              {pr.commentCount}
            </span>
          )}
          {pr.zapTotal > 0 && (
            <span className="inline-flex items-center gap-0.5 text-amber-500">
              <Zap className="h-3 w-3" />
              {compactNumber(pr.zapTotal)}
            </span>
          )}
          {pr.participantCount > 1 && (
            <span className="inline-flex items-center gap-0.5">
              <Users className="h-3 w-3" />
              {pr.participantCount}
            </span>
          )}
        </Link>
      )}
      {needsAttributionCheck && (
        <div className="flex shrink-0 items-center self-center">
          <RepoItemAttributionIndicator
            repo={repo}
            repoCoords={pr.repoCoords}
            itemLabel={pr.itemType === "patch" ? "patch" : "pull request"}
            pageSuffix={`/prs/${nevent}`}
          />
        </div>
      )}
    </li>
  );
}

function PRSkeleton() {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Skeleton className="h-5 w-5 rounded-full shrink-0 mt-0.5" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </li>
  );
}
