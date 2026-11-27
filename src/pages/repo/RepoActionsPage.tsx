/** Repository-wide CI activity with adaptive coordinator trust filtering. */

import { CIJobResultEvent } from "@/casts/CIJobResult";
import { CIJobRow } from "@/components/ci/CIChecksPanel";
import { CI_JOB_RESULT_KIND } from "@/lib/ci";
import { hasAcceptedRepositoryReference, type ResolvedRepo } from "@/lib/nip34";
import { useEventStore } from "@/hooks/useEventStore";
import { use$ } from "@/hooks/use$";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import { map } from "rxjs";
import { useLocation } from "react-router-dom";
import { useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { useSeoMeta } from "@unhead/react";
import { RepoActionsList } from "@/components/ci/RepoActionsList";
import { CICoordinatorSummaryBar } from "@/components/ci/CICoordinatorPanel";
import { useRepoCI } from "@/hooks/useCI";
import { useRepositoryCITrust } from "@/hooks/useRepositoryCITrust";
import { useRepoContext } from "./RepoContext";

/** A provider can publish a job before a workflow quotes it. Keep its
 * permalink readable without assigning that job to a guessed attempt. */
function LinkedJobResult({
  repo,
  anchor,
}: {
  repo: ResolvedRepo;
  anchor: string;
}) {
  const store = useEventStore();
  const coords = repo.confirmedMaintainerCoordinates;
  const result = use$(
    () =>
      store
        .timeline([{ kinds: [CI_JOB_RESULT_KIND], "#a": coords } as Filter])
        .pipe(
          map((events) => {
            const event = events.find((candidate) =>
              candidate.id.startsWith(anchor),
            );
            return event
              ? new CIJobResultEvent(
                  event,
                  store as unknown as CastRefEventStore,
                )
              : undefined;
          }),
        ),
    [anchor, coords.join(","), store],
  );
  if (!result || !hasAcceptedRepositoryReference(result.repoCoords, repo)) {
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
        The linked event is missing from the CI activity loaded for this
        repository.
      </p>
    );
  }
  return (
    <section className="space-y-2 border-b p-4">
      <h3 className="font-semibold">Linked job result</h3>
      <p className="text-sm text-muted-foreground">
        No loaded workflow attempt references this job.
      </p>
      <CIJobRow
        job={{ jobId: result.jobId, result, status: result.status }}
        targetAnchor={anchor}
      />
    </section>
  );
}

export default function RepoActionsPage() {
  const { resolved, basePath } = useRepoContext();
  const repo = resolved?.repo;
  const { hash } = useLocation();
  const anchor = /^#[a-f0-9]{15}$/.test(hash) ? hash.slice(1) : undefined;
  const account = useActiveAccount();
  const isMaintainer =
    !!account && !!repo?.confirmedMaintainers.includes(account.pubkey);
  const runs = useRepoCI(
    repo?.confirmedMaintainerCoordinates,
    repo?.selectedCoordinate,
  );
  const { coordinatorState, relationships, trust } = useRepositoryCITrust(
    repo,
    runs,
  );
  const coordinators = coordinatorState?.coordinators;
  const coordinatorAvailability = useMemo(
    () =>
      new Map(
        (coordinators ?? []).map(
          ({ pubkey, availability }) => [pubkey, availability] as const,
        ),
      ),
    [coordinators],
  );

  useSeoMeta({
    title: repo ? `Actions - ${repo.name} - ngit` : "Actions - ngit",
    description: "CI workflow runs for this repository",
  });

  return (
    <div className="container max-w-screen-xl px-4 py-6 md:px-8">
      <CICoordinatorSummaryBar
        coordinators={coordinators}
        runs={runs}
        basePath={basePath}
        relationships={relationships}
        trust={trust}
      />

      <RepoActionsList
        key={anchor}
        anchor={anchor}
        missingAnchorContent={
          repo && anchor ? (
            <LinkedJobResult repo={repo} anchor={anchor} />
          ) : undefined
        }
        runs={coordinators === undefined ? undefined : runs}
        repo={repo}
        basePath={basePath}
        canRetry={isMaintainer}
        coordinatorRelationships={relationships}
        serviceControls={coordinatorState?.serviceControls}
        coordinatorAvailability={coordinatorAvailability}
        adaptiveCoordinatorFilter
        trust={trust}
      />
    </div>
  );
}
