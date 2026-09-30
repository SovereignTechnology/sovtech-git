import { useSyncExternalStore } from "react";
import { z } from "zod";

const schema = z.object({
  statusFilter: z.array(
    z.enum(["open", "draft", "resolved", "closed", "deleted"]),
  ),
  labelFilter: z.array(z.string()),
  authorFilter: z.string().nullable(),
  searchQuery: z.string(),
  typeFilter: z.array(z.enum(["pr", "patch"])),
  // null = all targets; empty string = the repository's default branch.
  targetBranchFilter: z.string().nullable(),
});
type RepoListState = z.infer<typeof schema>;
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

// Also preserves navigation state when sessionStorage is unavailable.
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
  const cached = snapshots.get(key);
  if (cached) return cached;
  let state = defaults;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw !== null) state = schema.parse(JSON.parse(raw));
  } catch {
    // Invalid or inaccessible storage must not prevent using the list.
  }
  snapshots.set(key, state);
  return state;
}

function write(key: string, state: RepoListState, reset = false) {
  try {
    if (reset) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Keep the in-memory snapshot usable when storage is blocked or full.
  }
  snapshots.set(key, state);
  listeners.forEach((listener) => listener());
}

/** Remember each resolved repository's lists independently for this tab. */
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
