/**
 * git.sovtech.pro's footer. It shadows src/components/AppFooter.tsx through
 * ci/sovtech/shadow-map.tsv: the site map, the theme choice, provenance and
 * the build identity, built exactly as upstream builds it.
 */
import { Link } from "react-router-dom";
import { Moon, Sun, SunMoon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { use$ } from "@/hooks/use$";
import { setThemeMode, themeMode, type ThemeMode } from "@/services/settings";
import { DOCUMENTATION_URLS } from "@/lib/documentation";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/sovtech/brand/BrandMark";
import {
  GITHUB_MIRROR_URL,
  LINEAGE_PATH,
  SOVTECH_GIT_ISSUES_PATH,
  SOVTECH_GIT_PATH,
  SOVTECH_WWW_URL,
} from "@/sovtech/links";

Reflect.set(globalThis, Symbol.for("sovtech.overlay.AppFooter"), true);

const gitCommit = __GIT_COMMIT__;
const commitDate = __COMMIT_DATE__;
const releaseVersion = __APP_RELEASE_VERSION__;

const TAGLINE = "Git over Nostr, run from El Salvador.";
const LEGAL = "© 2026 Sovereign Technology · MIT";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const TEXT_LINK = cn(
  "rounded-sm text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground",
  FOCUS_RING,
);

interface FooterLink {
  label: string;
  to: string;
  /** A full URL, rendered as a plain <a>; otherwise a router Link. */
  external?: boolean;
}

interface FooterSection {
  heading: string;
  links: FooterLink[];
}

const NAV_SECTIONS: FooterSection[] = [
  {
    heading: "Get started",
    links: [
      { label: "Install ngit", to: DOCUMENTATION_URLS.install, external: true },
      {
        label: "Quick start",
        to: DOCUMENTATION_URLS.quickstart,
        external: true,
      },
      { label: "About", to: "/about" },
    ],
  },
  {
    heading: "Navigate",
    links: [
      { label: "Dashboard", to: "/" },
      { label: "Landing page", to: "/landing" },
      { label: "Browse repositories", to: "/search" },
    ],
  },
  {
    heading: "SovTech",
    links: [
      { label: "sovtech.pro", to: SOVTECH_WWW_URL, external: true },
      { label: "Source on Nostr", to: SOVTECH_GIT_PATH },
      { label: "GitHub mirror", to: GITHUB_MIRROR_URL, external: true },
      { label: "Report an issue", to: SOVTECH_GIT_ISSUES_PATH },
    ],
  },
];

interface ThemeOption {
  value: ThemeMode;
  label: string;
  Icon: typeof Sun;
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: SunMoon },
];

function isThemeMode(value: string): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function FooterNavLink({ link }: { link: FooterLink }) {
  const className = cn("text-sm", TEXT_LINK);
  if (link.external) {
    return (
      <a href={link.to} className={className}>
        {link.label}
      </a>
    );
  }
  return (
    <Link to={link.to} className={className}>
      {link.label}
    </Link>
  );
}

export function AppFooter() {
  const mode = use$(themeMode);

  // Same host-in-use wordmark as the header (see AppHeader): both names share
  // one web root, so the brand line is the host actually being served.
  const host = window.location.hostname;
  const dot = host.indexOf(".");
  const hostLabel = dot > 0 ? host.slice(0, dot) : host;
  const hostSuffix = dot > 0 ? host.slice(dot) : "";

  return (
    <footer className="mt-24 border-t border-border/40 bg-muted/30">
      <div className="container max-w-screen-xl px-4 md:px-8">
        <div className="grid gap-10 py-12 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:gap-16">
          {/* Brand */}
          <div className="flex flex-col gap-3">
            <Link
              to="/"
              className={cn(
                "flex w-fit items-center gap-2 rounded-md transition-opacity duration-150 ease-out hover:opacity-80",
                FOCUS_RING,
              )}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <BrandMark className="h-4 w-4" />
              </span>
              <span className="font-mono text-sm font-bold tracking-tight">
                {hostLabel}
                <span className="text-brand">{hostSuffix}</span>
              </span>
            </Link>
            <p className="max-w-xs text-sm text-muted-foreground">{TAGLINE}</p>
            <p className="text-xs text-muted-foreground">{LEGAL}</p>
          </div>

          {/* Site map */}
          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-8 sm:grid-cols-3"
          >
            {NAV_SECTIONS.map((section) => (
              <div key={section.heading} className="flex flex-col gap-3">
                <p className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {section.heading}
                </p>
                <ul className="flex flex-col gap-2">
                  {section.links.map((link) => (
                    <li key={link.label}>
                      <FooterNavLink link={link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          {/* Theme */}
          <div className="flex items-start">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={mode}
              onValueChange={(value) => {
                // Radix sends "" when the pressed item is clicked again.
                if (isThemeMode(value)) setThemeMode(value);
              }}
              aria-label="Theme"
            >
              {THEME_OPTIONS.map(({ value, label, Icon }) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  className="h-8 gap-1.5 px-2.5 text-xs data-[state=on]:font-bold"
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border/40 py-2">
          <span className="font-mono text-xs text-muted-foreground">
            {releaseVersion ? `Android v${releaseVersion} · ` : "Web · "}
            {commitDate}+{gitCommit.slice(0, 7)}
          </span>
          <Link to={LINEAGE_PATH} className={cn("text-xs", TEXT_LINK)}>
            Fork of gitworkshop · MIT
          </Link>
        </div>
      </div>
    </footer>
  );
}
