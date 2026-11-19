import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { format, formatDistanceToNow } from "date-fns";
import { nip19 } from "nostr-tools";
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  Cpu,
  ExternalLink,
  Shield,
  RadioTower,
} from "lucide-react";
import type { CIProviderAdvertisement } from "@/casts/CIProvider";
import type { CIJobResultEvent } from "@/casts/CIJobResult";
import { CIStatusIcon } from "@/components/ci/CIStatusIcon";
import { CITrustContextLabel } from "@/components/ci/CITrustContextLabel";
import { EventCardActions } from "@/components/EventCardActions";
import { RepoBadge } from "@/components/RepoBadge";
import { UserAvatar } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useCIProviderAdvertisement,
  type CIProviderAdvertisementState,
} from "@/hooks/useCIProviderAdvertisement";
import { useCICoordinatorAdvertisement } from "@/hooks/useCICoordinatorProfile";
import { useCIProviderJobs } from "@/hooks/useCIProviderJobs";
import { useCITrustContext } from "@/hooks/useCITrustContext";
import { useLoadProfile } from "@/hooks/useLoadProfile";
import { useProfile } from "@/hooks/useProfile";
import { useDefaultRepoCoordPath } from "@/hooks/useRepoPath";
import { ciStatusLabel } from "@/lib/ci";
import { getCITrustResolution } from "@/lib/ciTrustContext";
import { decodePubkeyIdentifier } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/NotFound";

export default function CIProviderPage() {
  const { providerIdentifier = "" } = useParams();
  const [searchParams] = useSearchParams();
  const pubkey = decodePubkeyIdentifier(providerIdentifier);
  useLoadProfile(pubkey);
  const profile = useProfile(pubkey);
  const relayHints = searchParams.getAll("relay");
  const state = useCIProviderAdvertisement(pubkey, relayHints);
  const coordinatorState = useCICoordinatorAdvertisement(pubkey);
  const coordinatorAdvertisement = coordinatorState.advertisement;
  const providerJobs = useCIProviderJobs(pubkey, relayHints);
  const trust = useCITrustContext({
    extraIdentities: pubkey ? [pubkey] : [],
  });
  const { advertisements, now } = state;
  const hasProviderAdvertisement = advertisements.length > 0;
  const currentOfferings = advertisements.filter(
    (ad) => !ad.isLegacy && ad.event.created_at <= now && ad.expiration > now,
  );
  const npub = pubkey ? nip19.npubEncode(pubkey) : undefined;
  const displayName =
    profile?.displayName ??
    profile?.name ??
    (npub ? `${npub.slice(0, 16)}…` : "CI identity");
  const providerIsLive = currentOfferings.length > 0;
  const coordinatorIsLive =
    coordinatorAdvertisement !== undefined &&
    coordinatorAdvertisement.expiration > now;
  const hasAdvertisedRole =
    hasProviderAdvertisement || !!coordinatorAdvertisement;
  const hasLiveRole = providerIsLive || coordinatorIsLive;
  const hasObservedProviderRole = providerJobs.jobs.length > 0;
  const rolesSettled =
    state.settled && coordinatorState.settled && providerJobs.settled;

  useSeoMeta({
    title: `${displayName} CI identity - ngit`,
    description:
      "CI identity, observed signed roles, capabilities, and trust context",
    ogImage: profile?.picture ?? "/og-image.png",
    ogImageAlt: displayName,
    twitterCard: profile?.picture ? "summary" : "summary_large_image",
  });

  if (!pubkey || !npub) return <NotFound />;

  return (
    <div className="min-h-full">
      <header className="relative isolate overflow-hidden border-b border-border/50">
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-violet-500/[0.08] via-background to-pink-500/[0.08]" />
        <div className="container max-w-screen-xl px-4 py-8 md:px-8 md:py-10">
          <Link
            to="/"
            className="mb-7 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            All repositories
          </Link>

          <div className="flex min-w-0 items-start gap-4 sm:gap-5">
            <div className="relative shrink-0">
              <UserAvatar
                pubkey={pubkey}
                size="xl"
                className="ring-4 ring-background shadow-lg"
              />
              {hasAdvertisedRole && (
                <span
                  className={cn(
                    "absolute bottom-0 right-0 h-4 w-4 rounded-full border-[3px] border-background",
                    hasLiveRole ? "bg-emerald-500" : "bg-amber-500",
                  )}
                  aria-label={
                    hasLiveRole
                      ? "At least one CI advertisement is current"
                      : "No current CI offering or coordinator advertisement"
                  }
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="w-full min-w-0 truncate text-2xl font-bold tracking-tight sm:w-auto sm:text-3xl md:text-4xl">
                  {displayName}
                </h1>
                {hasProviderAdvertisement && (
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        providerIsLive ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    {providerIsLive
                      ? `${currentOfferings.length} current ${currentOfferings.length === 1 ? "offering" : "offerings"}`
                      : "Provider advertisements"}
                  </Badge>
                )}
                {!hasProviderAdvertisement && hasObservedProviderRole && (
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                    Observed provider
                  </Badge>
                )}
                {coordinatorAdvertisement && (
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        coordinatorIsLive ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    {coordinatorIsLive
                      ? "Live coordinator"
                      : "Offline coordinator"}
                  </Badge>
                )}
                <CITrustContextLabel
                  resolution={getCITrustResolution(trust, pubkey)}
                />
              </div>
              <p className="mt-2 text-lg text-muted-foreground">
                {hasProviderAdvertisement
                  ? "Compute offerings advertised by this provider."
                  : hasObservedProviderRole
                    ? "Signed Job Results show that this key executed CI jobs; no current provider advertisement was found."
                    : coordinatorAdvertisement
                      ? "A signed coordinator advertisement was found; no provider advertisement or observed Job Result was found."
                      : rolesSettled
                        ? "No signed provider or coordinator role evidence was found on the available relays."
                        : "Resolving signed CI roles and capabilities."}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {profile?.nip05 && (
                  <span className="font-medium text-pink-600 dark:text-pink-400">
                    {profile.nip05.startsWith("_@")
                      ? profile.nip05.slice(2)
                      : profile.nip05}
                  </span>
                )}
                <Link
                  to={`/${npub}`}
                  className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Nostr profile
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
                {coordinatorAdvertisement && (
                  <Link
                    to={`/coordinator/${npub}`}
                    className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Coordinator profile
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="container max-w-screen-xl px-4 py-8 md:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(19rem,0.9fr)]">
          <div className="min-w-0 space-y-6">
            <ProviderOfferings
              state={state}
              hasObservedJobs={hasObservedProviderRole}
            />
            <ProviderJobsCard state={providerJobs} />
          </div>
          <aside className="space-y-6">
            <Card className="border-dashed">
              <CardContent className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">CI trust context</h2>
                  <CITrustContextLabel
                    resolution={getCITrustResolution(trust, pubkey)}
                  />
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  This global view uses verified identity evidence and
                  viewer-relative network activity. A repository view can
                  additionally show an accepted result from an independently
                  contextual coordinator.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  A provider signs the direct execution claim. Trust context
                  does not guarantee the job output or make the provider a
                  repository maintainer.
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ProviderOfferings({
  state,
  hasObservedJobs,
}: {
  state: CIProviderAdvertisementState;
  hasObservedJobs: boolean;
}) {
  const { advertisements, now } = state;
  if (!state.settled && advertisements.length === 0) {
    return (
      <Card>
        <CardContent
          className="space-y-4 p-6"
          aria-label="Loading provider offerings"
        >
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </CardContent>
      </Card>
    );
  }
  return (
    <section aria-labelledby="provider-offerings-title" className="space-y-4">
      <div>
        <h2
          id="provider-offerings-title"
          className="flex items-center gap-2 text-xl font-semibold"
        >
          <RadioTower className="h-5 w-5 text-violet-500" /> Provider offerings
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Availability is a signed snapshot, not a reservation. Offerings may
          share capacity.
        </p>
      </div>
      {advertisements.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="px-6 py-12 text-center">
            <Cpu className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="font-semibold">No provider offerings found</h3>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
              {hasObservedJobs
                ? "This provider has signed job results, but no current offering was found on the available relays."
                : "No current offering was found on the available relays. This does not establish whether the provider is online."}
            </p>
          </CardContent>
        </Card>
      ) : (
        advertisements.map((advertisement) => (
          <ProviderOfferingCard
            key={`${advertisement.event.kind}:${advertisement.offeringId ?? "legacy"}`}
            advertisement={advertisement}
            now={now}
          />
        ))
      )}
      {state.partial && (
        <p className="text-sm text-muted-foreground">
          Some relay queries could not be completed; additional offerings may
          exist elsewhere.
        </p>
      )}
      {advertisements.length > 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Capabilities and isolation are provider claims, not execution
          attestation or repository authorization. Expired advertisements are
          retained only when observed during this visit.
        </p>
      )}
    </section>
  );
}

function ProviderOfferingCard({
  advertisement: ad,
  now,
}: {
  advertisement: CIProviderAdvertisement;
  now: number;
}) {
  const expired = ad.expiration <= now;
  const future = ad.event.created_at > now;
  const current = !expired && !future;
  const capacity = ad.capacity;
  const state = expired
    ? "Expired"
    : future
      ? "Not yet current"
      : ad.isLegacy
        ? "Legacy"
        : capacity?.available === 0
          ? "Busy"
          : "Available";
  const isolation =
    ad.isolation === "hardware-vm"
      ? "Hardware VM"
      : ad.isolation === "weak-container"
        ? "Shared-kernel container"
        : "Direct execution";
  return (
    <Card className={cn("overflow-hidden", !current && "border-dashed")}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-4">
        <div className="min-w-0">
          <CardTitle className="break-words text-lg">
            {ad.offeringId ?? "Legacy provider advertisement"}
          </CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "gap-1.5 font-normal",
                current &&
                  !ad.isLegacy &&
                  capacity?.available !== 0 &&
                  "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  !current || ad.isLegacy
                    ? "bg-muted-foreground"
                    : capacity?.available === 0
                      ? "bg-amber-500"
                      : "bg-emerald-600",
                )}
              />
              {state}
            </Badge>
            {ad.isolation && (
              <Badge variant="secondary" className="gap-1.5 font-normal">
                <Shield className="h-3.5 w-3.5" />
                {isolation}
              </Badge>
            )}
          </div>
        </div>
        <EventCardActions event={ad.event} />
      </CardHeader>
      <CardContent className="space-y-4">
        {ad.isLegacy && (
          <p className="text-sm text-muted-foreground">
            Older capability format. No per-offering capacity or isolation was
            advertised.
          </p>
        )}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <CapabilityList
            title={ad.isLegacy ? "Runner selectors" : "Systems"}
            values={ad.runnerSelectors}
            icon={<Cpu className="h-4 w-4" />}
          />
          {capacity && (
            <div className="min-w-32">
              <p className="text-sm font-medium">
                {current ? "Available slots" : "Last reported slots"}
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {capacity.available}
                <span className="text-base font-normal text-muted-foreground">
                  {" "}
                  / {capacity.total}
                </span>
              </p>
            </div>
          )}
        </div>
        {ad.environment && (
          <div className="min-w-0">
            <p className="text-sm font-medium">Environment reference</p>
            <a
              href={ad.environment.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex max-w-full items-center gap-1 rounded font-mono text-xs text-muted-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={ad.environment.hash}
            >
              <span className="truncate">{ad.environment.hash}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
            <p className="mt-1 text-xs text-muted-foreground">
              Provider-signed reference; manifest contents have not been
              verified.
            </p>
          </div>
        )}
        <div className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            Published{" "}
            {formatDistanceToNow(ad.event.created_at * 1000, {
              addSuffix: true,
            })}
            .
          </p>
          <p>
            {expired ? "Expired" : "Expires"}{" "}
            {format(ad.expiration * 1000, "MMM d, yyyy 'at' h:mm:ss a")}.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderJobsCard({
  state,
}: {
  state: ReturnType<typeof useCIProviderJobs>;
}) {
  if (!state.settled && state.jobs.length === 0) {
    return (
      <Card>
        <CardContent
          className="space-y-3 p-6"
          aria-label="Loading provider job history"
        >
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (state.jobs.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="px-6 py-10 text-center">
          <Clock3 className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
          <h2 className="font-semibold">No Job Results found</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            No signed kind:9841 Job Results from this key were found on its
            available relay hints or configured Git index relays.
          </p>
          {state.partial && (
            <p className="mx-auto mt-2 max-w-lg text-xs text-muted-foreground">
              Some relay queries could not be completed, so this history may be
              incomplete.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const visibleJobs = state.jobs.slice(0, 25);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          <Clock3 className="h-5 w-5 text-violet-500" />
          Observed job results
          <Badge variant="secondary" className="font-normal">
            {state.jobs.length}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Recent jobs this key claims to have executed. Each row links the
          signed result to its repository context when available.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {visibleJobs.map((job) => (
          <ProviderJobRow key={job.event.id} job={job} />
        ))}
        {state.jobs.length > visibleJobs.length && (
          <p className="pt-2 text-center text-xs text-muted-foreground">
            Showing the latest {visibleJobs.length} of {state.jobs.length} Job
            Results found.
          </p>
        )}
        {state.partial && (
          <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Some relay queries could not be completed; additional jobs may exist
            elsewhere.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ProviderJobRow({ job }: { job: CIJobResultEvent }) {
  const coordinate = job.repoCoord ?? "";
  const repoPath = useDefaultRepoCoordPath(coordinate);
  const title = job.name ?? job.jobId;

  return (
    <div className="rounded-lg border border-border/70 p-3 sm:p-4">
      <div className="flex min-w-0 items-start gap-3">
        <CIStatusIcon status={job.status} className="mt-0.5 h-4 w-4" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm font-medium">
              {title}
            </span>
            <span className="text-xs text-muted-foreground">
              {ciStatusLabel(job.status)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {coordinate &&
              (repoPath ? (
                <Link
                  to={repoPath}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RepoBadge coord={coordinate} asSpan />
                </Link>
              ) : (
                <RepoBadge coord={coordinate} asSpan />
              ))}
            {job.workflowPath && (
              <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5">
                {job.workflowPath}
              </code>
            )}
            {job.commitId && (
              <span className="font-mono">{job.commitId.slice(0, 8)}</span>
            )}
            <span>
              {formatDistanceToNow(job.event.created_at * 1000, {
                addSuffix: true,
              })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.logUrl && (
            <a
              href={job.logUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Open full job log"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <EventCardActions event={job.event} />
        </div>
      </div>
    </div>
  );
}

function CapabilityList({
  title,
  values,
  icon,
}: {
  title: string;
  values: readonly string[];
  icon: ReactNode;
}) {
  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <Badge
            key={value}
            variant="secondary"
            className="max-w-full break-all font-mono"
          >
            {value}
          </Badge>
        ))}
      </div>
    </section>
  );
}
