/**
 * SovTech Git's landing page, shown to logged-out visitors on the root route.
 * It shadows src/pages/LandingPage.tsx through ci/sovtech/shadow-map.tsv and
 * sets no head tags: Index.tsx is not shadowed and owns them.
 *
 * Sections:
 *   1. Hero: headline, lead, two CTAs and a terminal example
 *   2. From SovTech: repositories the SovTech key announced and signed
 *      (hidden when there are none)
 *   3. Live on the network: upstream's featured strip
 *   4. How it works: three steps
 *   5. Why SovTech Git: six tiles
 *   6. Closing CTA
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  GitBranch,
  GitCommitHorizontal,
  Key,
  LockOpen,
  MapPin,
  Search,
  Shield,
  Terminal,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useRepositorySearch } from "@/hooks/useRepositorySearch";
import { useUserRepositories } from "@/hooks/useUserRepositories";
import { useDefaultRepoPath } from "@/hooks/useRepoPath";
import { UserLink } from "@/components/UserAvatar";
import { formatDistanceToNow } from "date-fns";
import type { ResolvedRepo } from "@/lib/nip34";
import { DOCUMENTATION_URLS } from "@/lib/documentation";
import { BrandMark } from "@/sovtech/brand/BrandMark";
import { LINEAGE_PATH, SOVTECH_PUBKEY, SOVTECH_WWW_URL } from "@/sovtech/links";
import { isSignedOnlyBy } from "@/sovtech/signed";

Reflect.set(globalThis, Symbol.for("sovtech.overlay.LandingPage"), true);

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const TEXT_LINK =
  "rounded-sm text-brand underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SECTION = "border-t border-border/40 py-16 md:py-24";
const CONTAINER = "container max-w-screen-xl px-4 md:px-8";
const H2 = "font-mono text-2xl font-bold tracking-tight md:text-3xl";

// ---------------------------------------------------------------------------
// Repository strips
// ---------------------------------------------------------------------------

interface FeaturedRepoCardProps {
  repo: ResolvedRepo;
  /** Shown in place of the maintainers' profiles (the From SovTech strip). */
  byline?: ReactNode;
}

// Copied from src/pages/LandingPage.tsx (FeaturedRepoCard); classes and byline.
function FeaturedRepoCard({ repo, byline }: FeaturedRepoCardProps) {
  const repoPath = useDefaultRepoPath(repo);
  const timeAgo = formatDistanceToNow(new Date(repo.updatedAt * 1000), {
    addSuffix: true,
  });

  return (
    <Link
      to={repoPath}
      className={`group block h-full rounded-lg ${FOCUS_RING}`}
    >
      <Card className="h-full transition-colors duration-150 ease-out group-hover:border-brand/40 motion-safe:transition motion-safe:duration-200 motion-safe:group-hover:-translate-y-0.5">
        <CardContent className="p-4 flex flex-col h-full">
          <div className="flex items-center gap-2 mb-2">
            <GitBranch
              className="h-4 w-4 shrink-0 text-brand"
              aria-hidden="true"
            />
            <h3 className="font-mono font-bold text-base tracking-tight truncate">
              {repo.name}
            </h3>
          </div>

          {repo.description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mb-3 flex-1">
              {repo.description}
            </p>
          )}

          <div className="flex items-center gap-2 mt-auto pt-2 border-t border-border/40">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {byline ??
                repo.confirmedMaintainers.slice(0, 2).map((pk) => (
                  <UserLink
                    key={pk}
                    pubkey={pk}
                    avatarSize="xs"
                    nameClassName="text-xs text-muted-foreground"
                    noLink
                  />
                ))}
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {timeAgo}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// Copied from src/pages/LandingPage.tsx (FeaturedReposSkeleton); count added.
function FeaturedReposSkeleton({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="h-full">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Skeleton className="h-6 w-6 rounded" />
              <Skeleton className="h-4 w-32" />
            </div>
            <Skeleton className="h-3 w-full mb-1" />
            <Skeleton className="h-3 w-3/4 mb-3" />
            <div className="flex items-center gap-2 pt-2 border-t border-border/40">
              <Skeleton className="h-4 w-4 rounded-full" />
              <Skeleton className="h-3 w-20" />
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

interface StripHeaderProps {
  id: string;
  title: string;
  subline: string;
  browseAll: boolean;
}

function StripHeader({ id, title, subline, browseAll }: StripHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-6 mb-8">
      <div>
        <h2 id={id} className={H2}>
          {title}
        </h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">{subline}</p>
      </div>
      {browseAll && (
        <Button variant="outline" asChild className="hidden sm:flex shrink-0">
          <Link to="/search">
            Browse all
            <ArrowRight className="h-4 w-4 ml-2" aria-hidden="true" />
          </Link>
        </Button>
      )}
    </div>
  );
}

/**
 * How long an empty SovTech strip waits before it hides, as upstream's
 * featured strip waits before its empty state.
 */
const SOVTECH_SETTLE_MS = 2_000;

/**
 * The From SovTech cards' byline. The only confirmed member of every card is
 * the SovTech key (isSignedOnlyBy), and its profile (kind 0) comes through the
 * same unverified EventStore, so the byline is fixed rather than a profile a
 * relay could forge.
 */
const SOVTECH_BYLINE = (
  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <BrandMark className="h-4 w-4 shrink-0 text-brand" />
    Sovereign Technology
  </span>
);

/** Whether a repository's card shows only what the SovTech key signed. */
function isSignedBySovtech(repo: ResolvedRepo): boolean {
  return isSignedOnlyBy(repo, SOVTECH_PUBKEY);
}

/**
 * Repositories announced by the SovTech key, through the same hook and relay
 * query as a user's profile page (useUserRepositories). The EventStore does
 * not verify signatures, so only repositories whose announcements SovTech
 * signed are kept (src/sovtech/signed.ts): a forged one never shows under
 * this heading. The strip hides itself when that list is still empty after
 * the settle delay.
 */
function SovtechRepos() {
  const announced = useUserRepositories(SOVTECH_PUBKEY);
  const repos = useMemo(
    () => announced?.filter(isSignedBySovtech),
    [announced],
  );
  const [emptySettled, setEmptySettled] = useState(false);

  useEffect(() => {
    if (repos === undefined || repos.length > 0) {
      setEmptySettled(false);
      return;
    }

    const timer = setTimeout(() => {
      setEmptySettled(true);
    }, SOVTECH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [repos]);

  const featured = repos?.slice(0, 6) ?? [];
  if (featured.length === 0 && emptySettled) return null;

  return (
    <section aria-labelledby="from-sovtech" className={SECTION}>
      <div className={CONTAINER}>
        <StripHeader
          id="from-sovtech"
          title="From SovTech"
          subline="Repositories announced by Sovereign Technology's own key."
          browseAll={false}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {featured.length > 0 ? (
            featured.map((repo) => (
              <FeaturedRepoCard
                key={repo.componentId}
                repo={repo}
                byline={SOVTECH_BYLINE}
              />
            ))
          ) : (
            <FeaturedReposSkeleton count={3} />
          )}
        </div>
      </div>
    </section>
  );
}

// Copied from src/pages/LandingPage.tsx (FeaturedRepos); classes and copy.
function FeaturedRepos() {
  const { repos, isLoading } = useRepositorySearch("");

  const graspRepos = useMemo(
    () => repos?.filter((r) => r.graspCloneUrls.length > 0),
    [repos],
  );
  const [emptyGraspResultsSettled, setEmptyGraspResultsSettled] =
    useState(false);

  useEffect(() => {
    if (graspRepos === undefined || graspRepos.length > 0 || isLoading) {
      setEmptyGraspResultsSettled(false);
      return;
    }

    const timer = setTimeout(() => {
      setEmptyGraspResultsSettled(true);
    }, 2_000);
    return () => clearTimeout(timer);
  }, [graspRepos, isLoading]);

  const showSkeletons =
    graspRepos === undefined ||
    (graspRepos.length === 0 && (isLoading || !emptyGraspResultsSettled));
  const featured = graspRepos?.slice(0, 6) ?? [];

  return (
    <section aria-labelledby="live-on-the-network" className={SECTION}>
      <div className={CONTAINER}>
        <StripHeader
          id="live-on-the-network"
          title="Live on the network"
          subline="Recent repositories on GRASP servers, straight from the Nostr git index. Published by their authors, not reviewed by SovTech."
          browseAll
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {showSkeletons ? (
            <FeaturedReposSkeleton />
          ) : featured.length > 0 ? (
            featured.map((repo) => (
              <FeaturedRepoCard key={repo.componentId} repo={repo} />
            ))
          ) : (
            <p className="col-span-full text-center py-8 text-muted-foreground text-sm">
              {"No repositories found yet. Check your relay connections in "}
              <Link to="/settings" className={TEXT_LINK}>
                Settings
              </Link>
              {"."}
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-center sm:hidden">
          <Button variant="outline" asChild className="w-full">
            <Link to="/search">
              Browse all repositories
              <ArrowRight className="h-4 w-4 ml-2" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

const HOW_IT_WORKS_STEPS = [
  {
    number: "01",
    icon: Terminal,
    title: "Install ngit",
    description:
      "One command installs ngit and git-remote-nostr on Linux, macOS or Windows.",
    install: true,
  },
  {
    number: "02",
    icon: GitCommitHorizontal,
    title: "Publish your repo",
    description:
      "Run ngit init in any git repository. It announces the repo on Nostr relays and pushes it to GRASP servers such as git.sovit.xyz. No signup, just your keypair.",
    install: false,
  },
  {
    number: "03",
    icon: Users,
    title: "Collaborate in the open",
    description:
      "Issues, patches and pull requests travel as signed Nostr events. Anyone can contribute from any NIP-34 client, this one included.",
    install: false,
  },
];

function HowItWorks() {
  return (
    <section aria-labelledby="how-it-works" className={SECTION}>
      <div className={CONTAINER}>
        <div className="text-center mb-12">
          <h2 id="how-it-works" className={H2}>
            How it works
          </h2>
          <p className="mt-2 text-muted-foreground">Three steps, no account.</p>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {HOW_IT_WORKS_STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <li key={step.number} className="flex flex-col gap-4">
                <div className="flex items-center gap-4">
                  <div className="flex items-center justify-center h-12 w-12 shrink-0 rounded-md border border-brand/30 bg-brand/10">
                    <Icon className="h-6 w-6 text-brand" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                      {`Step ${step.number}`}
                    </p>
                    <h3 className="font-mono font-bold text-base tracking-tight">
                      {step.title}
                    </h3>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {step.description}
                </p>
                {step.install && (
                  <div className="flex flex-wrap items-center gap-4 mt-auto">
                    <Button variant="outline" size="sm" asChild>
                      <a href={DOCUMENTATION_URLS.install}>
                        Install ngit
                        <ArrowRight
                          className="h-3.5 w-3.5 ml-1.5"
                          aria-hidden="true"
                        />
                      </a>
                    </Button>
                    <a
                      href={DOCUMENTATION_URLS.quickstart}
                      className={`text-sm ${TEXT_LINK}`}
                    >
                      Quick start
                    </a>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Why SovTech Git
// ---------------------------------------------------------------------------

const FEATURES = [
  {
    icon: Key,
    title: "Your keys, your identity",
    description:
      "A Nostr keypair is your account. Sign in with a browser extension or a remote signer; there is nothing for anyone to suspend.",
  },
  {
    icon: Shield,
    title: "No platform in the middle",
    description:
      "This site is a static client. Your code lives on the GRASP servers and relays you choose, ours in El Salvador among them.",
  },
  {
    icon: GitBranch,
    title: "Plain git",
    description:
      "Clone, branch, commit and push as you do today. ngit adds a Nostr transport; it does not replace git.",
  },
  {
    icon: MapPin,
    title: "Served from El Salvador",
    description:
      "Served from our own hardware in El Salvador, with defaults that include our own relay and GRASP server.",
  },
  {
    icon: LockOpen,
    title: "Open and forkable",
    description:
      "MIT licensed. Tracks upstream gitworkshop, with a weekly drift check; the source is public on Nostr and GitHub.",
  },
  {
    icon: Users,
    title: "Interoperable",
    description:
      "Built on NIP-34 and GRASP, so everything you publish here is readable by every Nostr git client.",
  },
];

function FeatureHighlights() {
  return (
    <section aria-labelledby="why-sovtech-git" className={SECTION}>
      <div className={CONTAINER}>
        <div className="text-center mb-12">
          <h2 id="why-sovtech-git" className={H2}>
            Why SovTech Git
          </h2>
          <p className="mt-2 text-muted-foreground">
            Git that answers to its owners, not to a platform.
          </p>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <li
                key={feature.title}
                className="flex gap-4 p-6 rounded-lg border border-border/60 bg-card"
              >
                <div className="flex items-center justify-center h-8 w-8 shrink-0 rounded-md border border-brand/30 bg-brand/10">
                  <Icon className="h-4 w-4 text-brand" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="font-mono font-bold text-base tracking-tight mb-1">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Closing CTA
// ---------------------------------------------------------------------------

function FooterCTA() {
  return (
    <section aria-labelledby="closing-cta" className={SECTION}>
      <div className={CONTAINER}>
        <div className="relative isolate overflow-hidden rounded-lg border border-brand/30 bg-card p-8 md:p-16 text-center">
          {/* Decorative tint, 10% at most */}
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand/10 via-transparent to-transparent" />

          <Badge variant="secondary" className="mb-4 font-mono">
            Open source · MIT
          </Badge>

          <h2 id="closing-cta" className={`${H2} mb-4`}>
            Your repo. Your keypair. Your rules.
          </h2>
          <p className="text-muted-foreground text-lg mb-8 max-w-xl mx-auto">
            {
              "Push code, track issues and review changes over Nostr, from a client run in El Salvador."
            }
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" asChild>
              <a href={DOCUMENTATION_URLS.install}>
                <Terminal className="h-5 w-5 mr-2" aria-hidden="true" />
                Install ngit
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/search">
                <Search className="h-5 w-5 mr-2" aria-hidden="true" />
                Browse repositories
              </Link>
            </Button>
          </div>

          <p className="mt-8 text-sm text-muted-foreground">
            {"Need sovereign infrastructure for your team? "}
            <a href={SOVTECH_WWW_URL} className={TEXT_LINK}>
              Sovereign Technology builds and runs it
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main LandingPage
// ---------------------------------------------------------------------------

const TERMINAL = [
  { comment: "# publish a repository", command: "ngit init" },
  { comment: "# propose a change", command: "git push -u origin pr/my-change" },
];

export function LandingPage() {
  return (
    <div className="min-h-full">
      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className={CONTAINER}>
          <div className="max-w-3xl mx-auto text-center">
            <p className="inline-flex items-center rounded-full border border-brand/30 bg-brand/10 px-3 py-1 font-mono text-xs uppercase tracking-wider">
              Sovereign Technology · El Salvador
            </p>

            <div className="flex justify-center mt-8 mb-6">
              <div className="flex items-center justify-center h-16 w-16 rounded-md bg-primary text-primary-foreground">
                <BrandMark className="h-10 w-10" />
              </div>
            </div>

            <h1 className="font-mono text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-balance">
              <span className="block">Your keys. Your code.</span>
              <span className="block text-brand">Git over Nostr.</span>
            </h1>

            <p className="mt-6 text-lg md:text-xl text-muted-foreground leading-relaxed max-w-2xl mx-auto">
              {
                "SovTech Git is a web client for git collaboration over Nostr and "
              }
              <a href={DOCUMENTATION_URLS.grasp} className={TEXT_LINK}>
                GRASP
              </a>
              {
                ", run by Sovereign Technology in El Salvador. Browse repositories, open issues and review pull requests, signed with your own keypair. No account to create, no platform to trust."
              }
            </p>

            <div className="flex flex-col sm:flex-row gap-3 justify-center mt-10">
              <Button size="lg" asChild className="text-base">
                <Link to="/search">
                  <Search className="h-5 w-5 mr-2" aria-hidden="true" />
                  Browse repositories
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild className="text-base">
                <a href={DOCUMENTATION_URLS.install}>
                  <Terminal className="h-5 w-5 mr-2" aria-hidden="true" />
                  Install ngit
                </a>
              </Button>
            </div>

            <figure
              aria-label="Example"
              className="mt-12 mx-auto max-w-md overflow-hidden rounded-lg border border-border bg-card text-left font-mono text-sm"
            >
              <div className="flex flex-col gap-1 p-4">
                {TERMINAL.map((line) => (
                  <div key={line.command}>
                    <p className="text-muted-foreground">{line.comment}</p>
                    <p>
                      <span className="text-brand">{"$ "}</span>
                      {line.command}
                    </p>
                  </div>
                ))}
                <p>
                  <span className="text-brand">{"$ "}</span>
                  <span
                    aria-hidden="true"
                    className="inline-block h-4 w-2 translate-y-0.5 bg-foreground motion-safe:animate-pulse"
                  />
                </p>
              </div>
            </figure>

            <p className="mt-6 text-xs text-muted-foreground">
              {"A fork of gitworkshop, with SovTech defaults. "}
              <Link to={LINEAGE_PATH} className={TEXT_LINK}>
                Read the lineage
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* From SovTech */}
      <SovtechRepos />

      {/* Live on the network */}
      <FeaturedRepos />

      {/* How it works */}
      <HowItWorks />

      {/* Why SovTech Git */}
      <FeatureHighlights />

      {/* Closing CTA */}
      <FooterCTA />
    </div>
  );
}
