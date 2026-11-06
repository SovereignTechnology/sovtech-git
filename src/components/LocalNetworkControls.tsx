import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { useAuthModal } from "@/contexts/AuthModalContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  answerConnectionPrompt,
  approveLocalEndpoint,
  connectionPrompt,
  forgetLocalEndpoint,
  localEndpoints,
  localEndpoint,
  localAccessAllowed,
  localNetworkRevision,
  networkPermission,
  refreshNetworkPermissions,
  showConnectionPrompt,
  subscribeLocalNetwork,
} from "@/lib/localNetwork";
import { hasInjectedCache } from "@/services/cache";
import {
  LOCAL_CACHE_ORIGIN,
  localCacheChoice,
  subscribeLocalCacheChoice,
  rememberLocalCacheChoice,
  startLocalCache,
  stopLocalCache,
} from "@/services/localCache";

const reasons = {
  git: "This repository uses a Git server on your device or local network to load its files.",
  relay:
    "This relay is on your device or local network. Connect to load and send Nostr events.",
  signer:
    "Your signer uses this local relay to connect your account and handle signing requests.",
  cache:
    "Look for local services on this device, such as a relay for faster loading.",
};

/** Explain local services declared by the current repository before connecting. */
export function RepositoryLocalConnectionNotice({
  relays,
  cloneUrls,
}: {
  relays: string[];
  cloneUrls: string[];
}) {
  useSyncExternalStore(subscribeLocalNetwork, localNetworkRevision);
  const services = [
    ...relays.map((url) => ({ url, purpose: "relay" as const })),
    ...cloneUrls.map((url) => ({ url, purpose: "git" as const })),
  ];
  const local = new Map<
    string,
    {
      endpoint: NonNullable<ReturnType<typeof localEndpoint>>;
      relay: boolean;
      git: boolean;
    }
  >();
  for (const { url, purpose } of services) {
    const endpoint = localEndpoint(url);
    if (!endpoint || localAccessAllowed(url)) continue;
    const entry = local.get(endpoint.origin) ?? {
      endpoint,
      relay: false,
      git: false,
    };
    entry[purpose] = true;
    local.set(endpoint.origin, entry);
  }
  if (!local.size) return null;
  return (
    <section
      aria-label="Repository local connections"
      className="container max-w-screen-xl px-4 md:px-8 mt-4"
    >
      <div className="rounded-xl border bg-background p-4 space-y-3">
        <div>
          <h2 className="font-semibold">This repository uses local services</h2>
          <p className="text-sm text-muted-foreground mt-1">
            These servers are listed in this repository’s relays or clone URLs.
            Connect to access them on your device or local network. Public
            servers can load normally.
          </p>
        </div>
        {[...local.values()].map(({ endpoint, relay, git }) => {
          const denied = networkPermission(endpoint.space) === "denied";
          return (
            <div
              key={endpoint.origin}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="font-mono text-sm break-all">
                  {git
                    ? endpoint.origin
                    : endpoint.origin.replace(/^http/, "ws")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {relay && git
                    ? "Nostr events and Git files"
                    : git
                      ? "Git files · listed in clone URLs"
                      : "Nostr events · listed in repository relays"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {denied
                    ? "Allow local access in your browser’s site settings, then check again."
                    : "Your browser may ask for permission."}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (denied)
                    void refreshNetworkPermissions().then(() => {
                      if (networkPermission(endpoint.space) !== "denied")
                        approveLocalEndpoint(endpoint.origin);
                    });
                  else approveLocalEndpoint(endpoint.origin);
                }}
              >
                {denied ? "Check permission" : "Connect"}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function LocalNetworkSettings() {
  useSyncExternalStore(subscribeLocalNetwork, localNetworkRevision);
  const account = useActiveAccount();
  const cacheChoice = useSyncExternalStore(
    subscribeLocalCacheChoice,
    localCacheChoice,
  );
  return (
    <Card id="local-connections">
      <CardHeader>
        <CardTitle>Local connections</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasInjectedCache && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">Local service discovery</p>
              <p className="text-sm text-muted-foreground">
                Optional · localhost:4869
              </p>
            </div>
            <Button
              variant="outline"
              disabled={!account}
              onClick={() => {
                if (cacheChoice) {
                  rememberLocalCacheChoice(false);
                  stopLocalCache();
                  forgetLocalEndpoint(LOCAL_CACHE_ORIGIN);
                } else showConnectionPrompt(LOCAL_CACHE_ORIGIN, "cache");
              }}
            >
              {cacheChoice ? "Turn off" : "Set up"}
            </Button>
          </div>
        )}
        {localEndpoints()
          .filter((e) => e.approved || e.pending)
          .map((endpoint) => (
            <div
              key={endpoint.origin}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <p className="break-all font-mono text-sm">{endpoint.origin}</p>
              <Button
                variant="outline"
                onClick={() =>
                  endpoint.approved
                    ? forgetLocalEndpoint(endpoint.origin)
                    : showConnectionPrompt(endpoint.origin)
                }
              >
                {endpoint.approved ? "Disconnect" : "Connect"}
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

export function LocalNetworkControls() {
  const networkRevision = useSyncExternalStore(
    subscribeLocalNetwork,
    localNetworkRevision,
  );
  const account = useActiveAccount();
  const cacheChoice = useSyncExternalStore(
    subscribeLocalCacheChoice,
    localCacheChoice,
  );
  const { isOpen: authOpen } = useAuthModal();
  const offered = useRef(false);
  const [cacheMessage, setCacheMessage] = useState("");
  const noticeAttempt = useRef(0);
  const prompt = connectionPrompt();
  const endpoint = prompt && localEndpoint(prompt.origin);
  const denied = endpoint && networkPermission(endpoint.space) === "denied";

  useEffect(() => {
    if (!account) {
      stopLocalCache();
      offered.current = false;
      noticeAttempt.current++;
      setCacheMessage("");
      return;
    }
    // Restore opted-in caching for both existing sessions and fresh logins.
    // The optional offer below never occupies the connection approval queue.
    if (!cacheChoice) {
      stopLocalCache();
      offered.current = false;
      noticeAttempt.current++;
      setCacheMessage("");
      return;
    }
    if (
      hasInjectedCache ||
      authOpen ||
      prompt ||
      offered.current ||
      !localEndpoint(LOCAL_CACHE_ORIGIN)?.approved
    )
      return;
    offered.current = true;
    // Remembered approval enables quiet discovery on later visits and tabs.
    void startLocalCache();
  }, [account, authOpen, prompt, cacheChoice, networkRevision]);

  useEffect(
    () => () => {
      noticeAttempt.current++;
      stopLocalCache();
    },
    [],
  );

  useEffect(() => {
    if (!cacheMessage) return;
    const timeout = setTimeout(() => setCacheMessage(""), 5_000);
    return () => clearTimeout(timeout);
  }, [cacheMessage]);

  const cacheOffer =
    !!account &&
    !hasInjectedCache &&
    !authOpen &&
    (prompt?.purpose === "cache" || (!prompt && cacheChoice === undefined));
  const cacheDenied = networkPermission("loopback") === "denied";

  const answerCache = (allowed: boolean) => {
    const showFirstResult = cacheChoice !== true;
    const attempt = ++noticeAttempt.current;
    offered.current = allowed;
    setCacheMessage("");
    if (prompt?.purpose === "cache") answerConnectionPrompt(allowed);
    else if (allowed) approveLocalEndpoint(LOCAL_CACHE_ORIGIN);
    else forgetLocalEndpoint(LOCAL_CACHE_ORIGIN);
    rememberLocalCacheChoice(allowed);
    if (allowed) {
      void startLocalCache().then(async (connected) => {
        await refreshNetworkPermissions();
        if (
          connected === false &&
          showFirstResult &&
          attempt === noticeAttempt.current
        )
          setCacheMessage(
            networkPermission("loopback") === "denied"
              ? "Local access is blocked. You can change this in your browser’s site settings."
              : "No local relay found. We’ll look again next time.",
          );
      });
    }
  };

  const answer = (allowed: boolean) => {
    answerConnectionPrompt(allowed);
  };

  return (
    <>
      {cacheOffer && (
        <section
          aria-label="Local services"
          className="fixed bottom-4 right-4 left-4 z-40 rounded-xl border bg-background p-4 shadow-lg sm:left-auto sm:w-96"
        >
          <div role="status">
            <h2 className="text-lg font-semibold">
              Allow access to local services?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Look for local services on this device, such as a relay for faster
              loading.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {cacheDenied
                ? "Your browser blocked access. You can change this in site settings."
                : networkPermission("loopback") === "granted"
                  ? "Optional. You can keep browsing either way."
                  : "Your browser may ask for permission."}
            </p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => answerCache(false)}>
              Not now
            </Button>
            <Button disabled={cacheDenied} onClick={() => answerCache(true)}>
              Allow
            </Button>
          </div>
        </section>
      )}
      {cacheMessage && !prompt && !cacheOffer && (
        <div
          role="status"
          className="fixed bottom-4 right-4 left-4 z-40 rounded-lg border bg-background p-4 shadow-sm sm:left-auto sm:max-w-sm"
        >
          <p className="text-sm">{cacheMessage}</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCacheMessage("")}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
      <AlertDialog
        open={!!prompt && prompt.purpose !== "cache"}
        onOpenChange={(open) => {
          if (!open) answer(false);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {prompt?.purpose === "cache"
                ? "Allow access to local services?"
                : "Connect to this local server?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {prompt && reasons[prompt.purpose]}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all rounded-lg bg-muted px-4 py-3 font-mono text-sm">
            {prompt?.origin}
          </p>
          <p className="text-sm text-muted-foreground">
            {denied
              ? "Your browser blocked access. Allow local network access in this site's browser settings, then try again."
              : "Your browser may ask for permission next."}
          </p>
          <AlertDialogFooter className="gap-2 sm:space-x-0">
            <Button variant="outline" onClick={() => answer(false)}>
              Not now
            </Button>
            <Button disabled={!!denied} onClick={() => answer(true)}>
              Continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
