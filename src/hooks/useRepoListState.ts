import { useSyncExternalStore } from "react";
import type { IssueStatus, PRItemType } from "@/lib/nip34";

interface RepoListState {
  statusFilter: IssueStatus[];
  labelFilter: string[];
  authorFilter: string | null;
  searchQuery: string;
  typeFilter: PRItemType[];
  // null = all targets; empty string = the repository's default branch.
  targetBranchFilter: string | null;
}
type ListKind = "issues" | "prs";

const commonDefaults = {
  labelFilter: [],
  authorFilter: null,
  searchQuery: "",
  typeFilter: [],
  targetBranchFilter: null,
};
export const REPO_LIST_DEFAULTS: Record<ListKind, RepoListState> = {
  issues: { ...commonDefaults, statusFilter: ["open"] },
  prs: { ...commonDefaults, statusFilter: ["open", "draft"] },
};

// Survives page unmounts during navigation, but a browser reload clears it.
const snapshots = new Map<string, RepoListState>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(key: string | undefined, defaults: RepoListState): RepoListState {
  if (!key) return defaults;
  return snapshots.get(key) ?? defaults;
}

function write(key: string, state: RepoListState, reset = false) {
  if (reset) snapshots.delete(key);
  else snapshots.set(key, state);
  listeners.forEach((listener) => listener());
}

/** Remember each resolved repository's lists independently until reload. */
export function useRepoListState(
  componentId: string | undefined,
  list: ListKind,
) {
  const defaults = REPO_LIST_DEFAULTS[list];
  // Do not create a shared fallback entry while repository identity is loading.
  const key = componentId
    ? `gitworkshop:repo-list:v1:${list}:${componentId}`
    : undefined;
  const state = useSyncExternalStore(subscribe, () => read(key, defaults));
  const update = <K extends keyof RepoListState>(
    field: K,
    value: RepoListState[K],
  ) => {
    if (key) write(key, { ...read(key, defaults), [field]: value });
  };
  const reset = () => {
    if (key) write(key, defaults, true);
  };
  return { state, update, reset };
}
