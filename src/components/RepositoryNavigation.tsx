import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Globe2, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  RelayCurationMode,
  RelayCurationPreference,
} from "@/services/settings";
import { cn } from "@/lib/utils";

export interface RepositoryTab {
  to: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  count?: number;
}

const tabClass =
  "inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap px-2 py-2.5 text-sm font-medium border-b-2 sm:gap-2 sm:px-4";
const moreClass =
  "inline-flex shrink-0 items-center justify-center px-2 py-2.5 text-sm border-b-2";
const relayClass = "h-8 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground";
const gap = 4; // Matches gap-1 in both the navigation and measurement row.

function TabContents({ tab }: { tab: RepositoryTab }) {
  return (
    <>
      {tab.icon}
      {tab.label}
      {tab.count !== undefined && tab.count > 0 && (
        <Badge
          variant="secondary"
          className="ml-0.5 h-5 min-w-5 shrink-0 px-1.5 text-[11px] font-medium sm:ml-1"
        >
          {tab.count}
        </Badge>
      )}
    </>
  );
}

function RelayContents({ mode }: { mode: RelayCurationMode }) {
  return (
    <>
      <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
      {mode === "repo" ? "Curated" : "Expanded relays"}
      <ChevronDown className="h-3 w-3" aria-hidden="true" />
    </>
  );
}

function RelayViewMenuItems({
  preference,
  defaultMode,
  onChange,
}: {
  preference: RelayCurationPreference;
  defaultMode: RelayCurationMode;
  onChange: (mode: RelayCurationPreference) => void;
}) {
  return (
    <>
      <DropdownMenuLabel>Repository view</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={preference}
        onValueChange={(value) => {
          if (value === "default" || value === "repo" || value === "outbox")
            onChange(value);
        }}
      >
        <DropdownMenuRadioItem value="default">
          Default ({defaultMode === "repo" ? "Curated" : "Expanded relays"})
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="repo">Curated</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="outbox">
          Expanded relays
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <p className="max-w-64 px-2 py-2 text-xs text-muted-foreground">
        Default follows your global setting. Other choices are saved for this
        repository in this browser. Expanded relays may include spam or content
        excluded by repository curation.
      </p>
    </>
  );
}

/** Measure natural item widths so only items that cannot fit move into More. */
export function RepositoryNavigation({
  tabs,
  relayView,
}: {
  tabs: RepositoryTab[];
  relayView?: {
    mode: RelayCurationMode;
    preference: RelayCurationPreference;
    defaultMode: RelayCurationMode;
    onChange: (mode: RelayCurationPreference) => void;
  };
}) {
  const container = useRef<HTMLDivElement>(null);
  const measurements = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ count: 0, relay: false });
  const measurementKey = tabs
    .map((tab) => `${tab.to}:${tab.label}:${tab.count ?? 0}`)
    .join("|");
  const hasRelayView = !!relayView;
  useLayoutEffect(() => {
    const host = container.current;
    const row = measurements.current;
    if (!host || !row) return;
    const measure = () => {
      const items = [
        ...row.querySelectorAll<HTMLElement>("[data-tab-measure]"),
      ];
      const widths = items.map((item) => item.getBoundingClientRect().width);
      const moreWidth = row
        .querySelector<HTMLElement>("[data-more-measure]")!
        .getBoundingClientRect().width;
      const relayWidth =
        row
          .querySelector<HTMLElement>("[data-relay-measure]")
          ?.getBoundingClientRect().width ?? 0;
      const available = host.getBoundingClientRect().width;
      const fullWidth =
        widths.reduce((sum, width) => sum + width, 0) +
        gap * Math.max(0, widths.length - 1) +
        (hasRelayView ? gap + relayWidth : 0);
      let count = widths.length;
      const relay = hasRelayView && fullWidth <= available;
      if (fullWidth > available) {
        let used = moreWidth;
        count = 0;
        for (const width of widths) {
          if (used + gap + width > available) break;
          used += gap + width;
          count++;
        }
      }
      setLayout((previous) =>
        previous.count === count && previous.relay === relay
          ? previous
          : { count, relay },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    for (const item of row.children) observer.observe(item);
    return () => observer.disconnect();
  }, [measurementKey, hasRelayView]);

  const hidden = tabs.slice(layout.count);
  const relayInMenu = !!relayView && !layout.relay;
  const hasOverflow = hidden.length > 0 || relayInMenu;
  return (
    <div ref={container} className="relative min-w-0">
      {/* Non-interactive measuring copies remain invisible and outside the accessibility tree. */}
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-0 h-0 overflow-hidden"
      >
        <div ref={measurements} className="flex w-max gap-1">
          {tabs.map((tab) => (
            <span key={tab.to} data-tab-measure className={tabClass}>
              <TabContents tab={tab} />
            </span>
          ))}
          <span data-more-measure className={moreClass}>
            <MoreHorizontal className="h-4 w-4" />
          </span>
          {relayView && (
            <span
              data-relay-measure
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                relayClass,
              )}
            >
              <RelayContents mode={relayView.mode} />
            </span>
          )}
        </div>
      </div>
      <nav
        aria-label="Repository"
        className="-mb-px flex min-w-0 items-center gap-1"
      >
        {tabs.slice(0, layout.count).map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={tab.active ? "page" : undefined}
            className={cn(
              tabClass,
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab.active
                ? "border-pink-500 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
            )}
          >
            <TabContents tab={tab} />
          </Link>
        ))}
        {hasOverflow && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More repository options"
                className={cn(
                  moreClass,
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  hidden.some((tab) => tab.active)
                    ? "border-pink-500 text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hidden.map((tab) => (
                <DropdownMenuItem key={tab.to} asChild>
                  <Link
                    to={tab.to}
                    aria-current={tab.active ? "page" : undefined}
                    className="flex items-center gap-2"
                  >
                    <TabContents tab={tab} />
                  </Link>
                </DropdownMenuItem>
              ))}
              {relayInMenu && relayView && (
                <>
                  {hidden.length > 0 && <DropdownMenuSeparator />}
                  <RelayViewMenuItems {...relayView} />
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {layout.relay && relayView && (
          <div className="ml-auto shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={relayClass}
                  aria-label="Repository relay view"
                >
                  <RelayContents mode={relayView.mode} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <RelayViewMenuItems {...relayView} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </nav>
    </div>
  );
}
