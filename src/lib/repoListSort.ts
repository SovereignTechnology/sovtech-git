import type { ResolvedIssueLite } from "@/lib/nip34";

export const REPO_LIST_SORT_OPTIONS = {
  "activity-desc": "Recently active",
  "activity-asc": "Least recently active",
  "created-desc": "Newest first",
  "created-asc": "Oldest first",
  "replies-desc": "Most replies",
  "replies-asc": "Fewest replies",
} as const;

export type RepoListSort = keyof typeof REPO_LIST_SORT_OPTIONS;
export const DEFAULT_REPO_LIST_SORT: RepoListSort = "activity-desc";

export function isRepoListSort(value: unknown): value is RepoListSort {
  return (
    typeof value === "string" && Object.hasOwn(REPO_LIST_SORT_OPTIONS, value)
  );
}

export function compareRepoItems(sort: RepoListSort) {
  type SortableItem = Pick<
    ResolvedIssueLite,
    "id" | "createdAt" | "lastActivityAt" | "commentCount"
  >;
  return (a: SortableItem, b: SortableItem): number => {
    const field = sort.startsWith("created-")
      ? "createdAt"
      : sort.startsWith("replies-")
        ? "commentCount"
        : "lastActivityAt";
    return (
      (a[field] - b[field]) * (sort.endsWith("asc") ? 1 : -1) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id)
    );
  };
}
