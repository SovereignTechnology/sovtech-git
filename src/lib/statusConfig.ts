import type { IssueStatus } from "@/lib/nip34";
import {
  IssueOpenedIcon,
  IssueClosedIcon,
  IssueDraftIcon,
  SkipIcon,
  TrashIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
} from "@primer/octicons-react";

export const statusConfig: Record<
  IssueStatus,
  { label: string; className: string; icon: React.ElementType }
> = {
  open: {
    label: "Open",
    className:
      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20",
    icon: IssueOpenedIcon,
  },
  resolved: {
    label: "Resolved",
    className:
      "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 hover:bg-purple-500/20",
    icon: IssueClosedIcon,
  },
  closed: {
    label: "Closed",
    className:
      "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20 hover:bg-slate-500/20",
    icon: SkipIcon,
  },
  draft: {
    label: "Draft",
    className:
      "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20 hover:bg-slate-500/20",
    icon: IssueDraftIcon,
  },
  deleted: {
    label: "Deleted",
    className:
      "bg-muted/50 text-muted-foreground border-muted-foreground/20 hover:bg-muted/70",
    icon: TrashIcon,
  },
};

/**
 * PR/patch variant overrides for status labels, icons and, where the PR
 * colour differs from the issue colour, badge classes.
 */
export const prStatusOverrides: Partial<
  Record<
    IssueStatus,
    { label: string; icon: React.ElementType; className?: string }
  >
> = {
  open: {
    label: "Open",
    icon: GitPullRequestIcon,
  },
  draft: {
    label: "Draft",
    icon: GitPullRequestDraftIcon,
  },
  resolved: {
    label: "Merged",
    icon: GitMergeIcon,
  },
  closed: {
    label: "Closed",
    icon: GitPullRequestClosedIcon,
    className:
      "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20 hover:bg-red-500/20",
  },
};
