import { useCallback, useSyncExternalStore } from "react";
import { Globe2 } from "lucide-react";
import { useOptionalRepoContext } from "@/pages/repo/RepoContext";
import { useRepositoryCuration } from "@/hooks/useRepositoryCuration";
import { relayEventPresence } from "@/lib/relayEventPresence";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Receipt/reconciliation evidence is independent of authorship and publishing status. */
export function RepositorySourceBadge({ eventId }: { eventId: string }) {
  const repo = useOptionalRepoContext()?.resolved?.repo;
  const { mode } = useRepositoryCuration();
  const active = !!repo && !repo.isPrivate && mode === "outbox";
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!active) return () => {};
      const sub = relayEventPresence.changes$.subscribe((ids) => {
        if (ids.has(eventId)) notify();
      });
      return () => sub.unsubscribe();
    },
    [active, eventId],
  );
  const snapshot = useCallback(() => {
    if (!active || relayEventPresence.has(eventId, repo?.relays ?? []))
      return false;
    // Other-relay receipt is not proof of absence from repository relays.
    return (
      relayEventPresence.isAbsent(eventId, repo?.relays ?? []) &&
      relayEventPresence.hasAny(eventId)
    );
  }, [active, eventId, repo?.relays]);
  const outsideRepository = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!outsideRepository) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-repository-source="outbox"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-700/20 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-800 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-400/20 dark:bg-amber-400/5 dark:text-amber-300"
        >
          <Globe2 className="h-3 w-3" aria-hidden="true" />
          Outbox only
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">
        Seen on other relays and absent from the completed repository-relay
        history checks. Repository relays may exclude content for spam or other
        curation reasons.
      </TooltipContent>
    </Tooltip>
  );
}
