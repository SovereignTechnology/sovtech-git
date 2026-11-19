import { cn } from "@/lib/utils";
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

const issueIconConfig: Record<
  IssueStatus,
  { icon: React.ElementType; className: string; title: string }
> = {
  open: {
    icon: IssueOpenedIcon,
    className: "text-emerald-600 dark:text-emerald-400",
    title: "Open",
  },
  draft: {
    icon: IssueDraftIcon,
    className: "text-slate-500 dark:text-slate-400",
    title: "Draft",
  },
  resolved: {
    icon: IssueClosedIcon,
    className: "text-purple-600 dark:text-purple-400",
    title: "Resolved",
  },
  closed: {
    icon: SkipIcon,
    className: "text-slate-500 dark:text-slate-400",
    title: "Closed",
  },
  deleted: {
    icon: TrashIcon,
    className: "text-muted-foreground",
    title: "Deleted",
  },
};

const prIconOverrides: Partial<
  Record<
    IssueStatus,
    { icon: React.ElementType; title: string; className?: string }
  >
> = {
  open: {
    icon: GitPullRequestIcon,
    title: "Open",
  },
  draft: {
    icon: GitPullRequestDraftIcon,
    title: "Draft",
  },
  resolved: {
    icon: GitMergeIcon,
    title: "Merged",
  },
  closed: {
    icon: GitPullRequestClosedIcon,
    title: "Closed",
    className: "text-red-600 dark:text-red-400",
  },
};

interface StatusIconProps {
  status: IssueStatus;
  className?: string;
  /**
   * When "pr" or "patch", uses PR-specific icons (GitPullRequest /
   * GitPullRequestDraft / GitMerge / GitPullRequestClosed). Patches share
   * the PR shapes because both are proposals on the same list and page.
   * Default: "issue".
   */
  variant?: "issue" | "pr" | "patch";
}

/**
 * Compact status icon for use in condensed list rows.
 * Shows just the icon with a status-appropriate color — no text label.
 */
export function StatusIcon({
  status,
  className,
  variant = "issue",
}: StatusIconProps) {
  const config = issueIconConfig[status];
  const override = variant === "issue" ? undefined : prIconOverrides[status];
  const Icon = override?.icon ?? config.icon;
  const title = override?.title ?? config.title;

  return (
    <Icon
      className={cn(
        "h-5 w-5 shrink-0",
        override?.className ?? config.className,
        className,
      )}
      aria-label={title}
    />
  );
}
