import { ArrowUpDown, ChevronDown, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ManualRetryAction } from "@/components/ErrorRetryAction";
import { REPO_LIST_SORT_OPTIONS, isRepoListSort } from "@/lib/repoListSort";
import type { useRepoListSortPreference } from "@/hooks/useRepoListSortPreference";

type Sorting = ReturnType<typeof useRepoListSortPreference>;

export function RepoListSortMenu({
  sorting,
  label,
}: {
  sorting: Sorting;
  label: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={label}
          className="h-9 gap-2"
        >
          <ArrowUpDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
          {REPO_LIST_SORT_OPTIONS[sorting.sort]}
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={sorting.sort}
          onValueChange={(value) => {
            if (isRepoListSort(value)) sorting.setSort(value);
          }}
        >
          {Object.entries(REPO_LIST_SORT_OPTIONS).map(([value, label]) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {label}
              {value === sorting.defaultSort && (
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  Default
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {sorting.signedIn && sorting.sort !== sorting.defaultSort && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={sorting.pending}
              onSelect={() => void sorting.makeDefault()}
              title="Save for issues and PRs across repositories and devices"
            >
              <Pin aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />
              {sorting.pending ? "Saving…" : "Set default"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RepoListSortFeedback({
  sorting,
  searching,
}: {
  sorting: Sorting;
  searching: boolean;
}) {
  return (
    <>
      {sorting.pending && (
        <p className="mb-3 text-xs text-muted-foreground" role="status">
          Saving default sort…
        </p>
      )}
      {searching && (
        <p className="mb-3 text-xs text-muted-foreground">
          Text search results are ranked by relevance.
        </p>
      )}
      {sorting.error && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          <span>Could not save default sort: {sorting.error}</span>
          <ManualRetryAction onRetry={sorting.retry} busy={sorting.pending} />
        </div>
      )}
    </>
  );
}
