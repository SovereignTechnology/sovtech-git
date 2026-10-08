import { cn } from "@/lib/utils";
import type { IssueStatus } from "@/lib/nip34";
import { Check, AlertTriangle } from "lucide-react";
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

interface StatusTabConfig {
  label: string;
  icon: React.ElementType;
  activeClass: string;
  activeBgClass: string;
  activeCountClass: string;
}

const slateTab = {
  activeClass: "text-slate-600 dark:text-slate-400",
  activeBgClass:
    "bg-slate-50 dark:bg-slate-950/30 border-slate-400 dark:border-slate-600",
  activeCountClass:
    "bg-slate-100 dark:bg-slate-900/50 text-slate-700 dark:text-slate-400",
};

const issueStatusConfig: Record<IssueStatus, StatusTabConfig> = {
  open: {
    label: "Open",
    icon: IssueOpenedIcon,
    activeClass: "text-emerald-600 dark:text-emerald-400",
    activeBgClass:
      "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-400 dark:border-emerald-600",
    activeCountClass:
      "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400",
  },
  draft: {
    label: "Draft",
    icon: IssueDraftIcon,
    ...slateTab,
  },
  resolved: {
    label: "Resolved",
    icon: IssueClosedIcon,
    activeClass: "text-purple-600 dark:text-purple-400",
    activeBgClass:
      "bg-purple-50 dark:bg-purple-950/30 border-purple-400 dark:border-purple-600",
    activeCountClass:
      "bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-400",
  },
  closed: {
    label: "Closed",
    icon: SkipIcon,
    ...slateTab,
  },
  deleted: {
    label: "Deleted",
    icon: TrashIcon,
    activeClass: "text-foreground",
    activeBgClass: "bg-accent border-border",
    activeCountClass: "bg-muted text-muted-foreground",
  },
};

const prStatusOverrides: Partial<
  Record<IssueStatus, Partial<StatusTabConfig>>
> = {
  open: {
    icon: GitPullRequestIcon,
  },
  draft: {
    icon: GitPullRequestDraftIcon,
  },
  resolved: {
    label: "Merged",
    icon: GitMergeIcon,
  },
  closed: {
    icon: GitPullRequestClosedIcon,
    activeClass: "text-red-600 dark:text-red-400",
    activeBgClass:
      "bg-red-50 dark:bg-red-950/30 border-red-400 dark:border-red-600",
    activeCountClass:
      "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400",
  },
};

interface StatusTabsProps {
  /** Count of items per status */
  counts: Record<IssueStatus, number>;
  /** Currently selected statuses */
  selected: IssueStatus[];
  /** Called when selection changes */
  onChange: (selected: IssueStatus[]) => void;
  /** Use PR labels (e.g. "Merged" instead of "Resolved") */
  variant?: "issue" | "pr";
  /** De-emphasized counts for invitee-addressed items */
  secondaryCounts?: Partial<Record<IssueStatus, number>>;
  className?: string;
}

/**
 * Multi-select status filter pills. Each pill acts as a toggle checkbox —
 * selected pills get a filled background + checkmark so the multi-select
 * affordance is immediately obvious.
 */
export function StatusTabs({
  counts,
  selected,
  onChange,
  variant = "issue",
  secondaryCounts,
  className,
}: StatusTabsProps) {
  const toggle = (status: IssueStatus) => {
    if (selected.includes(status)) {
      onChange(selected.filter((s) => s !== status));
    } else {
      onChange([...selected, status]);
    }
  };

  const statuses = (Object.keys(issueStatusConfig) as IssueStatus[]).filter(
    (status) =>
      counts[status] > 0 ||
      (secondaryCounts?.[status] ?? 0) > 0 ||
      selected.includes(status),
  );

  return (
    <div
      className={cn("flex items-center gap-1.5 flex-wrap", className)}
      role="group"
      aria-label="Filter by status"
    >
      {statuses.map((status) => {
        const config = {
          ...issueStatusConfig[status],
          ...(variant === "pr" ? prStatusOverrides[status] : undefined),
        };
        const Icon = config.icon;
        const label = config.label;
        const isActive = selected.includes(status);
        const count = counts[status];
        const secondaryCount = secondaryCounts?.[status] ?? 0;

        return (
          <button
            key={status}
            role="checkbox"
            aria-checked={isActive}
            onClick={() => toggle(status)}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm border transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? cn(
                    "font-medium border",
                    config.activeClass,
                    config.activeBgClass,
                  )
                : "text-muted-foreground border-transparent hover:border-border hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {isActive ? (
              <Check className="h-3 w-3 shrink-0" />
            ) : (
              <Icon className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>{label}</span>
            <span
              className={cn(
                "tabular-nums text-xs rounded-full px-1.5 py-0 leading-5 min-w-[1.25rem] text-center",
                isActive
                  ? config.activeCountClass
                  : "bg-muted text-muted-foreground",
              )}
            >
              {count}
            </span>
            {secondaryCount > 0 && (
              <span
                className="-ml-0.5 inline-flex items-center gap-0.5 text-xs font-normal tabular-nums text-muted-foreground"
                title={`${secondaryCount} ${
                  secondaryCount === 1 ? "item" : "items"
                } sent to other repositories`}
                aria-label={`${secondaryCount} ${
                  secondaryCount === 1 ? "item" : "items"
                } sent to other repositories`}
              >
                <AlertTriangle
                  className="h-3 w-3 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                {secondaryCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
