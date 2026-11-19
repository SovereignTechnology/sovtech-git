import type { ReactNode } from "react";
import { Search, Users, X, ListFilter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  MultiSelect,
  type MultiSelectOption,
} from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar, UserName } from "@/components/UserAvatar";
import {
  RepoListSortMenu,
  RepoListSortFeedback,
} from "@/components/RepoListSortMenu";
import type { useRepoListSortPreference } from "@/hooks/useRepoListSortPreference";

interface RepoListToolbarProps {
  list: "issues" | "prs";
  sorting: ReturnType<typeof useRepoListSortPreference>;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  searching: boolean;
  labelOptions: MultiSelectOption[];
  labelFilter: string[];
  setLabelFilter: (value: string[]) => void;
  authors: string[];
  authorFilter: string | null;
  setAuthorFilter: (value: string | null) => void;
  hasActiveFilters: boolean;
  onReset: () => void;
  beforeFilters?: ReactNode;
  children?: ReactNode;
}

export function RepoListToolbar({
  list,
  sorting,
  searchQuery,
  setSearchQuery,
  searching,
  labelOptions,
  labelFilter,
  setLabelFilter,
  authors,
  authorFilter,
  setAuthorFilter,
  hasActiveFilters,
  onReset,
  beforeFilters,
  children,
}: RepoListToolbarProps) {
  return (
    <>
      <div className="flex flex-wrap items-start gap-3 mb-3">
        <div className="relative w-full max-w-sm md:flex-1 md:min-w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${list === "issues" ? "issues" : "PRs"}, event ID or npub...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-background/60"
          />
        </div>

        <div className="flex gap-2 flex-wrap items-center ml-auto max-w-full">
          <RepoListSortMenu
            sorting={sorting}
            label={list === "issues" ? "Sort issues" : "Sort pull requests"}
          />
          {beforeFilters}
          {labelOptions.length > 0 && (
            <MultiSelect
              options={labelOptions}
              selected={labelFilter}
              onChange={setLabelFilter}
              placeholder="Label"
              icon={<ListFilter aria-hidden="true" className="h-4 w-4" />}
              className="w-[150px]"
            />
          )}

          {authors.length > 1 && (
            <Select
              value={authorFilter ?? "__all__"}
              onValueChange={(v) => setAuthorFilter(v === "__all__" ? null : v)}
            >
              <SelectTrigger
                aria-label="Filter by author"
                className="w-[160px] h-9 gap-2 text-sm"
              >
                <Users
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 text-left truncate">
                  <SelectValue placeholder="Author" />
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Authors</SelectItem>
                {authors.map((pk) => (
                  <SelectItem key={pk} value={pk}>
                    <AuthorSelectLabel pubkey={pk} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {children}
          {(hasActiveFilters || sorting.sort !== sorting.defaultSort) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-sm text-muted-foreground hover:text-foreground"
              onClick={onReset}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Reset
            </Button>
          )}
        </div>
      </div>

      <RepoListSortFeedback sorting={sorting} searching={searching} />
    </>
  );
}

function AuthorSelectLabel({ pubkey }: { pubkey: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <UserAvatar pubkey={pubkey} size="sm" />
      <UserName pubkey={pubkey} className="text-sm" />
    </div>
  );
}
