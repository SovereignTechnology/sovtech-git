import { useEffect, useMemo, useRef, useState } from "react";
import { Hash } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useOptionalRepoContext } from "@/pages/repo/RepoContext";
import { getHashtagSuggestions } from "@/lib/hashtagSuggestions";
import { hasAcceptedRepositoryReference } from "@/lib/nip34";
import { cn } from "@/lib/utils";
import { StatusIcon } from "@/components/StatusBadge";
import { statusConfig, prStatusOverrides } from "@/lib/statusConfig";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

interface HashtagAutocompleteDropdownProps {
  query: string;
  position: { top: number; left: number; height: number };
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  listboxId: string;
  onSelect: (replacement: string) => void;
  onClose: () => void;
  onActiveDescendantChange: (id: string | undefined) => void;
}

export function HashtagAutocompleteDropdown({
  query,
  position,
  textareaRef,
  listboxId,
  onSelect,
  onClose,
  onActiveDescendantChange,
}: HashtagAutocompleteDropdownProps) {
  const repo = useOptionalRepoContext();
  const resolvedRepo = repo?.resolved?.repo;
  const { labels, items } = useMemo(
    () =>
      getHashtagSuggestions(
        query,
        repo?.issues?.filter(
          (item) =>
            resolvedRepo &&
            hasAcceptedRepositoryReference(item.repoCoords, resolvedRepo),
        ),
        repo?.prs?.filter(
          (item) =>
            resolvedRepo &&
            hasAcceptedRepositoryReference(item.repoCoords, resolvedRepo),
        ),
      ),
    [query, repo?.issues, repo?.prs, resolvedRepo],
  );
  const options = useMemo(
    () => [
      ...labels.map((label) => ({ key: `label-${label}`, text: `#${label} ` })),
      ...items.map((item) => ({
        key: item.id,
        text: `nostr:${nip19.neventEncode({ id: item.id, author: item.pubkey, kind: item.event.kind })} `,
      })),
    ],
    [labels, items],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options[Math.min(selectedIndex, options.length - 1)];
  const optionId = (key: string) => `${listboxId}-${key}`;
  const activeId = selected ? optionId(selected.key) : undefined;
  const anchorRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          new DOMRect(position.left, position.top, 0, position.height),
      },
    }),
    [position],
  );

  useEffect(() => setSelectedIndex(0), [query]);
  useEffect(() => {
    onActiveDescendantChange(activeId);
    return () => onActiveDescendantChange(undefined);
  }, [activeId, onActiveDescendantChange]);
  useEffect(() => {
    if (activeId)
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  useEffect(() => {
    const dismissOnScroll = (event: Event) => {
      if (!listRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("scroll", dismissOnScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("scroll", dismissOnScroll, { capture: true });
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || options.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex(
          (index) =>
            (Math.min(index, options.length - 1) + delta + options.length) %
            options.length,
        );
      } else if ((event.key === "Enter" || event.key === "Tab") && selected) {
        event.preventDefault();
        onSelect(selected.text);
      }
    };
    textarea.addEventListener("keydown", handleKeyDown);
    return () => textarea.removeEventListener("keydown", handleKeyDown);
  }, [textareaRef, options, selected, onSelect]);

  const optionProps = (index: number) => ({
    id: optionId(options[index].key),
    role: "option",
    "aria-selected": options[index] === selected,
    tabIndex: -1,
    className: cn(
      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      options[index] === selected
        ? "bg-accent text-accent-foreground"
        : "hover:bg-accent/60",
    ),
    onPointerDown: (event: React.PointerEvent) => event.preventDefault(),
    onClick: () => onSelect(options[index].text),
  });

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        role="presentation"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="z-[100] w-80 max-w-[calc(100vw-16px)] overflow-hidden rounded-xl p-0 shadow-lg"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (
            event.target instanceof Node &&
            textareaRef.current?.contains(event.target)
          )
            event.preventDefault();
        }}
      >
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Labels, issues and pull requests"
          className="overflow-y-auto py-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border hover:[&::-webkit-scrollbar-thumb]:bg-border/80"
          style={{
            maxHeight:
              "max(0px, min(320px, calc(var(--radix-popover-content-available-height) - 2px)))",
            scrollbarWidth: "thin",
            scrollbarColor: "hsl(var(--border)) transparent",
          }}
        >
          {labels.length > 0 && (
            <div role="group" aria-label="Labels">
              <div
                className="px-3 py-2 text-xs font-medium text-muted-foreground"
                aria-hidden="true"
              >
                Labels
              </div>
              {labels.map((label, index) => (
                <button type="button" key={label} {...optionProps(index)}>
                  <Hash
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <div role="group" aria-label="Issues and pull requests">
              <div
                className="px-3 py-2 text-xs font-medium text-muted-foreground"
                aria-hidden="true"
              >
                Issues &amp; PRs
              </div>
              {items.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  {...optionProps(labels.length + index)}
                >
                  <StatusIcon
                    status={item.status}
                    variant={item.referenceType}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {item.currentSubject || "Untitled"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {item.referenceType === "pr" ? "PR" : "Issue"} #
                      {item.id.slice(0, 8)} ·{" "}
                      {item.referenceType === "pr"
                        ? (prStatusOverrides[item.status]?.label ??
                          statusConfig[item.status].label)
                        : statusConfig[item.status].label}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {options.length === 0 && (
            <p
              role="status"
              className="px-3 py-3 text-sm text-muted-foreground"
            >
              No matches. Keep typing to use a hashtag.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
