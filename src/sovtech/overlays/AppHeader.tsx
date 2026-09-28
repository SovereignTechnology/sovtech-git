/**
 * SovTech Git's header. It shadows src/components/AppHeader.tsx through
 * ci/sovtech/shadow-map.tsv and keeps upstream's controls: search, New
 * repository, notifications, Settings and the login area. It adds a skip
 * link, the SovTech mark and wordmark, and a link to www.sovtech.pro.
 */
import {
  useState,
  useRef,
  useEffect,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useActiveAccount } from "applesauce-react/hooks";
import { LoginArea } from "@/components/auth/LoginArea";
import { ArrowUpRight, Plus, Search, Settings, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { NavBarNotificationBadge } from "@/components/NavBarNotificationBadge";
import { CreateRepoDialog } from "@/components/CreateRepoDialog";
import { BrandMark } from "@/sovtech/brand/BrandMark";
import { SOVTECH_WWW_URL } from "@/sovtech/links";

Reflect.set(globalThis, Symbol.for("sovtech.overlay.AppHeader"), true);

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * Moves keyboard focus to the page content. AppRouter owns <main> and the
 * fork never edits it, so the target gets its tabIndex here.
 */
function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const main = document.querySelector("main");
  if (!main) return;
  main.tabIndex = -1;
  main.focus();
}

// Copied from src/components/AppHeader.tsx (HeaderSearchBar); classes only.
function HeaderSearchBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Mirror the current URL query so the bar stays in sync when navigating
  const urlQuery =
    location.pathname === "/search" ? (searchParams.get("q") ?? "") : "";
  const [value, setValue] = useState(urlQuery);

  // Keep local value in sync when the URL changes (e.g. browser back/forward)
  useEffect(() => {
    setValue(urlQuery);
  }, [urlQuery]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  };

  return (
    <form onSubmit={handleSubmit} className="relative w-56 xl:w-72">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search repositories…"
        className="h-8 pl-8 pr-3 text-sm bg-muted/50 border-border/50"
        aria-label="Search repositories"
      />
    </form>
  );
}

// Copied from src/components/AppHeader.tsx (HeaderSearchIcon); classes only.
function HeaderSearchIcon() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [open, setOpen] = useState(false);

  const urlQuery =
    location.pathname === "/search" ? (searchParams.get("q") ?? "") : "";
  const [value, setValue] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    if (open) {
      // Small delay so the element is visible before focusing
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
    setOpen(false);
  };

  if (open) {
    return (
      <form onSubmit={handleSubmit} className="flex items-center gap-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Search…"
            className="h-8 w-44 pl-8 pr-3 text-sm bg-muted/50 border-border/50"
            aria-label="Search repositories"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Close search"
          onClick={() => setOpen(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </form>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-8 w-8",
            location.pathname === "/search" && "bg-accent",
          )}
          aria-label="Search repositories"
          onClick={() => setOpen(true)}
        >
          <Search className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Search repositories</TooltipContent>
    </Tooltip>
  );
}

export function AppHeader() {
  const activeAccount = useActiveAccount();
  const [createRepoOpen, setCreateRepoOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <a
        href="#main"
        onClick={skipToMain}
        className={cn(
          "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium",
          FOCUS_RING,
        )}
      >
        Skip to content
      </a>
      <div className="container flex h-14 max-w-screen-xl items-center px-4 md:px-8">
        <Link
          to="/"
          aria-label="SovTech Git home"
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-md transition-opacity duration-150 ease-out hover:opacity-80",
            FOCUS_RING,
          )}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BrandMark className="h-5 w-5" />
          </span>
          <span className="hidden font-mono text-base font-bold tracking-tight sm:inline">
            SovTech<span className="text-brand"> Git</span>
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <a
            href={SOVTECH_WWW_URL}
            className={cn(
              "hidden items-center gap-1 rounded-sm font-mono text-xs text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground lg:inline-flex",
              FOCUS_RING,
            )}
          >
            sovtech.pro
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </a>

          {/* Search bar — hidden on narrow screens */}
          <div className="hidden sm:flex">
            <HeaderSearchBar />
          </div>

          {/* Search icon — only on narrow screens */}
          <div className="sm:hidden">
            <HeaderSearchIcon />
          </div>

          {/* Create repo button — only shown when logged in */}
          {activeAccount && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Create repository"
                  onClick={() => setCreateRepoOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New repository</TooltipContent>
            </Tooltip>
          )}

          {/* Notifications — only shown when logged in */}
          {activeAccount && <NavBarNotificationBadge />}

          {/* Settings — standalone icon when logged out (in user menu when logged in) */}
          {!activeAccount && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" asChild className="h-8 w-8">
                  <Link to="/settings" aria-label="Settings">
                    <Settings className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          )}

          <LoginArea className="max-w-60" />
        </div>
      </div>

      <CreateRepoDialog
        isOpen={createRepoOpen}
        onClose={() => setCreateRepoOpen(false)}
      />
    </header>
  );
}
