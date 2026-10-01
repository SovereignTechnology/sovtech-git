import { useEffect, useRef, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  acquireNotificationStore,
  releaseNotificationStore,
  updateReadState,
  type NotificationStoreEntry,
} from "@/services/notificationStore";
import {
  notificationHistoryWindowId,
  readNotificationHistory,
  recordNotificationSnapshot,
  watchNotificationHistory,
  type NotificationSnapshot,
} from "@/services/notificationHistory";

function utc(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace("T", " ")
    .replace("Z", " UTC");
}

function sourceLabel(snapshot: NotificationSnapshot): string {
  const here = snapshot.windowId === notificationHistoryWindowId;
  if (snapshot.source === "Produced version")
    return here ? "Produced here" : "Produced in this browser";
  if (snapshot.source === "Downloaded version")
    return here ? "Downloaded from relay" : "Relay download in another window";
  if (snapshot.source === "Other window version") return "From another window";
  if (snapshot.source === "Cached version") return "Loaded from cache";
  // Older journal entries did not distinguish relay delivery from cache hydration.
  return "Previously recorded";
}

function versions(snapshots: NotificationSnapshot[]): NotificationSnapshot[] {
  const grouped = new Map<string, NotificationSnapshot>();
  const rank = (snapshot: NotificationSnapshot) =>
    (snapshot.windowId === notificationHistoryWindowId ? 10 : 0) +
    (snapshot.source === "Produced version"
      ? 3
      : snapshot.source === "Downloaded version"
        ? 2
        : 0);
  for (const snapshot of snapshots) {
    if (!snapshot.eventId) continue;
    const existing = grouped.get(snapshot.eventId);
    if (!existing || rank(snapshot) > rank(existing))
      grouped.set(snapshot.eventId, snapshot);
  }
  return [...grouped.values()].sort(
    (a, b) =>
      (b.createdAt ?? b.recordedAt / 1000) -
        (a.createdAt ?? a.recordedAt / 1000) ||
      (a.eventId ?? "").localeCompare(b.eventId ?? ""),
  );
}

function AccountDiagnostics({ pubkey }: { pubkey: string }) {
  const [entry, setEntry] = useState<NotificationStoreEntry>();
  const [history, setHistory] = useState<NotificationSnapshot[]>();
  const [selected, setSelected] = useState<NotificationSnapshot>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let readRevision = 0;
    const refresh = () => {
      const revision = ++readRevision;
      void readNotificationHistory(pubkey).then(
        (snapshots) => {
          if (active && revision === readRevision)
            setHistory(versions(snapshots));
        },
        () => {
          if (active)
            setMessage(
              "Could not load saved versions. Check browser storage permissions.",
            );
        },
      );
    };
    const unwatch = watchNotificationHistory(pubkey, refresh);
    const store = acquireNotificationStore(pubkey);
    setEntry(store);
    refresh();
    return () => {
      active = false;
      mounted.current = false;
      unwatch();
      releaseNotificationStore(pubkey);
    };
  }, [pubkey]);

  const restore = async (snapshot: NotificationSnapshot) => {
    if (!entry?.notificationSync || busy) return;
    setBusy(true);
    const saved = await recordNotificationSnapshot(
      pubkey,
      entry.readState$.getValue(),
      "Before manual restore",
    );
    if (!mounted.current) return;
    if (saved) {
      updateReadState(entry, () => structuredClone(snapshot.state));
      setMessage("Version restored locally and queued for sync.");
    } else {
      setMessage(
        "Restore cancelled: the current state could not be backed up.",
      );
    }
    setBusy(false);
  };

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <Link to="/notifications" className="underline underline-offset-4">
        Back to notifications
      </Link>
      <div className="space-y-2">
        <h1 className="text-4xl font-bold">Notification versions</h1>
        <p className="text-lg text-muted-foreground">
          Updates live. All timestamps are UTC.
        </p>
      </div>
      {!history ? (
        <Skeleton className="h-32 w-full" />
      ) : history.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-muted-foreground">
          No saved versions yet. Versions appear when notification state is
          produced or received.
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {history.map((snapshot) => (
            <li
              key={snapshot.eventId}
              className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-medium tabular-nums">
                  {snapshot.createdAt !== undefined ? (
                    <time
                      dateTime={new Date(
                        snapshot.createdAt * 1000,
                      ).toISOString()}
                    >
                      {utc(snapshot.createdAt * 1000).replace(".000", "")}
                    </time>
                  ) : (
                    "Version timestamp unavailable"
                  )}
                </p>
                <p>{sourceLabel(snapshot)}</p>
                <p className="text-sm text-muted-foreground tabular-nums">
                  Seen {utc(snapshot.recordedAt)} ·{" "}
                  <span className="font-mono">
                    {snapshot.eventId?.slice(0, 12)}
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSelected(snapshot)}
                  aria-label={`View version ${snapshot.eventId?.slice(0, 12)}`}
                >
                  View
                </Button>
                <Button
                  variant="outline"
                  disabled={!entry || busy}
                  onClick={() => void restore(snapshot)}
                  aria-label={`Restore version ${snapshot.eventId?.slice(0, 12)}`}
                >
                  Restore
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Notification version</DialogTitle>
            <DialogDescription>
              {selected && sourceLabel(selected)}. Restoring replaces your
              read/archive state and queues it for sync.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <pre
                className="min-w-0 overflow-x-auto rounded-lg bg-muted p-4 text-sm"
                aria-label="Full notification version"
              >
                {JSON.stringify(
                  {
                    eventId: selected.eventId,
                    createdAt: selected.createdAt,
                    observedAt: utc(selected.recordedAt),
                    source: sourceLabel(selected),
                    state: selected.state,
                  },
                  null,
                  2,
                )}
              </pre>
              <Button
                variant="outline"
                disabled={!entry || busy}
                onClick={() => void restore(selected)}
              >
                Restore this version
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function NotificationDiagnosticsPage() {
  const account = useActiveAccount();
  if (!account)
    return (
      <div className="container py-12">
        <h1 className="text-4xl font-bold">Notification versions</h1>
        <p className="mt-4 text-lg">
          Sign in to view saved notification versions.
        </p>
      </div>
    );
  return <AccountDiagnostics key={account.pubkey} pubkey={account.pubkey} />;
}
