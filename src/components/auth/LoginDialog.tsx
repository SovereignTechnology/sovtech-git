import { approveLocalEndpoint, localEndpoint } from "@/lib/localNetwork";
import { defaultNostrConnectRelays } from "@/services/settings";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { ManualRetryAction } from "@/components/ErrorRetryAction";
// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Upload,
  AlertTriangle,
  ChevronDown,
  Loader2,
  Copy,
  Check,
  ExternalLink,
  X,
  Plus,
  ArrowLeft,
  Key,
  Wifi,
  Puzzle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { QRCodeCanvas } from "@/components/ui/qrcode";
import { APP_NAME } from "@/lib/constants";
import {
  useLoginActions,
  createNostrConnectSession,
  isAndroidDevice,
  isMobileDevice,
  type NostrConnectSession,
} from "@/hooks/useLoginActions";
import { DialogTitle } from "@radix-ui/react-dialog";
import { useIsMobile } from "@/hooks/useIsMobile";

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  onCreateAccount?: () => void;
}

type LoginPage = "landing" | "secret-key" | "remote-signer";

const validateNsec = (nsec: string) => {
  return /^nsec1[a-zA-Z0-9]{58}$/.test(nsec);
};

/** Extract the relay list embedded in a nostrconnect:// URI */
const relaysFromUri = (uri: string): string[] => {
  try {
    const url = new URL(uri);
    return url.searchParams.getAll("relay");
  } catch {
    return [];
  }
};

const validateBunkerUri = (uri: string) => {
  return uri.startsWith("bunker://");
};

const LoginDialog: React.FC<LoginDialogProps> = ({
  isOpen,
  onClose,
  onLogin,
  onCreateAccount,
}) => {
  const copyToClipboard = useCopyToClipboard();
  const [page, setPage] = useState<LoginPage>("landing");
  const [isLoading, setIsLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [nsec, setNsec] = useState("");
  const [bunkerUri, setBunkerUri] = useState("");
  const [nostrConnectSession, setNostrConnectSession] =
    useState<NostrConnectSession | null>(null);
  const [isWaitingForConnect, setIsWaitingForConnect] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showBunkerInput, setShowBunkerInput] = useState(false);
  const [errors, setErrors] = useState<{
    nsec?: string;
    bunker?: string;
    file?: string;
    extension?: string;
    amber?: string;
  }>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const login = useLoginActions();
  const isMobile = useIsMobile();
  const isAndroid = isAndroidDevice();
  const hasExtension = "nostr" in window;

  // Relay editor state for the nostrconnect session
  const [showRelayEditor, setShowRelayEditor] = useState(false);
  const [newRelayInput, setNewRelayInput] = useState("");
  const [localSigner, setLocalSigner] = useState(false);
  const [localPort, setLocalPort] = useState("7777");
  const [includeDefaults, setIncludeDefaults] = useState(true);
  const [otherRelays, setOtherRelays] = useState(() =>
    defaultNostrConnectRelays.getValue(),
  );
  const [localError, setLocalError] = useState("");

  // Generate a nostrconnect session (sync — just creates the ephemeral signer + URI)
  const generateConnectSession = useCallback((relays?: string[]) => {
    const signerName = isMobileDevice()
      ? `${APP_NAME} mobile`
      : `${APP_NAME} desktop`;
    const session = createNostrConnectSession(signerName, relays);
    setNostrConnectSession(session);
    setConnectError(null);
  }, []);

  // Start listening for the remote signer to connect (async)
  useEffect(() => {
    if (!nostrConnectSession || isWaitingForConnect || connectError) return;

    const startListening = async () => {
      setIsWaitingForConnect(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        await login.nostrconnect(nostrConnectSession, controller.signal);
        if (controller.signal.aborted) return;
        onLogin();
        onClose();
      } catch (error) {
        // Don't show an error if the abort was intentional (dialog closed or
        // relay list changed). The signer rejects with a plain Error("Aborted")
        // rather than a DOMException with name "AbortError", so we check both
        // the signal's aborted flag and the conventional name.
        const wasAborted =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError") ||
          (error instanceof Error && error.message === "Aborted");
        if (!wasAborted) {
          setConnectError(
            error instanceof Error ? error.message : "Connection failed",
          );
        }
        if (abortControllerRef.current === controller)
          setIsWaitingForConnect(false);
      }
    };

    startListening();
  }, [
    nostrConnectSession,
    login,
    onLogin,
    onClose,
    isWaitingForConnect,
    connectError,
  ]);

  // Clean up when the dialog closes
  useEffect(() => {
    if (!isOpen) {
      setNostrConnectSession(null);
      setIsWaitingForConnect(false);
      setConnectError(null);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }
  }, [isOpen]);

  // Reset all state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPage("landing");
      setIsLoading(false);
      setIsFileLoading(false);
      setNsec("");
      setBunkerUri("");
      setErrors({});
      setShowBunkerInput(false);
      setShowRelayEditor(false);
      setNewRelayInput("");
      setLocalSigner(false);
      setLocalPort("7777");
      setIncludeDefaults(true);
      setOtherRelays(defaultNostrConnectRelays.getValue());
      setLocalError("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [isOpen]);

  // Navigate to remote signer page and kick off session generation
  const handleGoToRemoteSigner = useCallback(() => {
    setPage("remote-signer");
    if (!nostrConnectSession && !connectError) {
      generateConnectSession();
    }
  }, [nostrConnectSession, connectError, generateConnectSession]);

  const handleBack = useCallback(() => {
    if (page === "remote-signer") {
      // Abort any pending connect when leaving the page
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      setNostrConnectSession(null);
      setIsWaitingForConnect(false);
      setConnectError(null);
      setShowRelayEditor(false);
      setNewRelayInput("");
    }
    setLocalSigner(false);
    setIncludeDefaults(true);
    setPage("landing");
    setErrors({});
  }, [page]);

  const handleRetry = useCallback(
    (relays?: string[]) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      setNostrConnectSession(null);
      setIsWaitingForConnect(false);
      setConnectError(null);
      generateConnectSession(
        relays ??
          (nostrConnectSession
            ? relaysFromUri(nostrConnectSession.uri)
            : undefined),
      );
    },
    [generateConnectSession, nostrConnectSession],
  );

  const updateSignerRelays = (
    local: boolean,
    port: string,
    includeOther: boolean,
    others = otherRelays,
  ) => {
    setCopied(false);
    setLocalError("");
    if (
      local &&
      (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    ) {
      abortControllerRef.current?.abort();
      setNostrConnectSession(null);
      setIsWaitingForConnect(false);
      setConnectError(null);
      setLocalError("Enter a port between 1 and 65535.");
      return;
    }
    const relays = [
      ...new Set([
        ...(local ? [`ws://localhost:${Number(port)}`] : []),
        ...(includeOther ? others : []),
      ]),
    ];
    if (!relays.length) return;
    // Changing these controls explicitly selects the signer's transport.
    relays.forEach((relay) => approveLocalEndpoint(relay));
    handleRetry(relays);
  };

  const handleRelayChange = (relays: string[]) => {
    if (!relays.length && !localSigner) return;
    setOtherRelays(relays);
    setNewRelayInput("");
    updateSignerRelays(localSigner, localPort, includeDefaults, relays);
  };

  const addSignerRelay = () => {
    try {
      const raw = newRelayInput.trim();
      const url = new URL(/^wss?:\/\//.test(raw) ? raw : `wss://${raw}`);
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Use a ws:// or wss:// relay URL without credentials.");
      handleRelayChange([...new Set([...otherRelays, url.href])]);
    } catch {
      setLocalError("Enter a valid relay URL.");
    }
  };

  const handleCopyUri = async () => {
    if (!nostrConnectSession) return;
    await copyToClipboard(nostrConnectSession.uri, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // On mobile, open the nostrconnect:// URI directly — this launches signer apps like Amber
  const handleOpenSignerApp = () => {
    if (!nostrConnectSession) return;
    window.location.href = nostrConnectSession.uri;
  };

  const handleExtensionLogin = async () => {
    setIsLoading(true);
    setErrors((prev) => ({ ...prev, extension: undefined }));

    try {
      if (!("nostr" in window)) {
        throw new Error(
          "Nostr extension not found. Please install a NIP-07 extension.",
        );
      }
      await login.extension();
      onLogin();
      onClose();
    } catch (e: unknown) {
      const error = e as Error;
      console.error("Extension login failed:", error);
      setErrors((prev) => ({
        ...prev,
        extension:
          error instanceof Error ? error.message : "Extension login failed",
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const handleAmberLogin = async () => {
    setIsLoading(true);
    setErrors((prev) => ({ ...prev, amber: undefined }));

    try {
      await login.amber();
      onLogin();
      onClose();
    } catch (error) {
      console.error("Amber login failed:", error);
      setErrors((prev) => ({
        ...prev,
        amber:
          error instanceof Error
            ? error.message
            : "Unable to connect to Amber. Please try again.",
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const executeLogin = (key: string) => {
    setIsLoading(true);
    setErrors({});

    // Timeout lets the UI update before the synchronous login call
    setTimeout(() => {
      try {
        login.nsec(key);
        onLogin();
        onClose();
      } catch {
        setErrors({
          nsec: "Failed to login with this key. Please check that it's correct.",
        });
        setIsLoading(false);
      }
    }, 50);
  };

  const handleKeyLogin = () => {
    if (!nsec.trim()) {
      setErrors((prev) => ({ ...prev, nsec: "Please enter your secret key" }));
      return;
    }

    if (!validateNsec(nsec)) {
      setErrors((prev) => ({
        ...prev,
        nsec: "Invalid secret key format. Must be a valid nsec starting with nsec1.",
      }));
      return;
    }
    executeLogin(nsec);
  };

  const handleBunkerLogin = async () => {
    if (!bunkerUri.trim()) {
      setErrors((prev) => ({ ...prev, bunker: "Please enter a bunker URI" }));
      return;
    }

    if (!validateBunkerUri(bunkerUri)) {
      setErrors((prev) => ({
        ...prev,
        bunker: "Invalid bunker URI format. Must start with bunker://",
      }));
      return;
    }

    setIsLoading(true);
    setErrors((prev) => ({ ...prev, bunker: undefined }));

    try {
      const relayUrls = new URL(bunkerUri.trim()).searchParams.getAll("relay");
      for (const relay of relayUrls) {
        approveLocalEndpoint(relay);
      }
      await login.bunker(bunkerUri.trim());
      onLogin();
      onClose();
      setBunkerUri("");
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        bunker:
          error instanceof Error
            ? error.message
            : "Failed to connect to bunker. Please check the URI.",
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileLoading(true);
    setErrors({});

    const reader = new FileReader();
    reader.onload = (event) => {
      setIsFileLoading(false);
      const content = event.target?.result as string;
      if (content) {
        const trimmedContent = content.trim();
        if (validateNsec(trimmedContent)) {
          executeLogin(trimmedContent);
        } else {
          setErrors({ file: "File does not contain a valid secret key." });
        }
      } else {
        setErrors({ file: "Could not read file content." });
      }
    };
    reader.onerror = () => {
      setIsFileLoading(false);
      setErrors({ file: "Failed to read file." });
    };
    reader.readAsText(file);
  };

  const pageTitle =
    page === "secret-key"
      ? "Secret Key"
      : page === "remote-signer"
        ? "Remote Signer"
        : "Log in";

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="max-w-[95vw] sm:max-w-sm max-h-[90dvh] p-0 gap-0 overflow-hidden rounded-2xl overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader className="px-6 pt-6 pb-2">
          <div className="flex items-center gap-2">
            {page !== "landing" && (
              <button
                type="button"
                onClick={handleBack}
                className="p-1 -ml-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <DialogTitle className="text-lg font-semibold leading-none tracking-tight flex-1 text-center pr-5">
              {pageTitle}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 pt-4 space-y-4">
          {/* ── Landing page ── */}
          {page === "landing" && (
            <>
              <div className="flex size-20 text-5xl bg-primary/10 rounded-full items-center justify-center mx-auto mb-2">
                🔑
              </div>

              <div className="space-y-3">
                {errors.extension && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="space-y-2">
                      <p>{errors.extension}</p>
                      <ManualRetryAction
                        onRetry={handleExtensionLogin}
                        busy={isLoading}
                      />
                    </AlertDescription>
                  </Alert>
                )}

                {errors.amber && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="space-y-2">
                      <p>{errors.amber}</p>
                      <ManualRetryAction
                        onRetry={handleAmberLogin}
                        busy={isLoading}
                      />
                    </AlertDescription>
                  </Alert>
                )}

                {hasExtension && (
                  <Button
                    className="w-full h-12 gap-3"
                    onClick={handleExtensionLogin}
                    disabled={isLoading}
                  >
                    <Puzzle className="w-4 h-4" />
                    {isLoading ? "Logging in..." : "Log in with Extension"}
                  </Button>
                )}

                <Button
                  variant="outline"
                  className="w-full h-12 gap-3"
                  onClick={() => setPage("secret-key")}
                >
                  <Key className="w-4 h-4" />
                  Secret Key
                </Button>

                {isAndroid && (
                  <Button
                    variant="outline"
                    className="w-full h-12 gap-3"
                    onClick={handleAmberLogin}
                    disabled={isLoading}
                  >
                    <Key className="w-4 h-4" />
                    {isLoading ? "Opening Amber..." : "Use Amber"}
                  </Button>
                )}

                <Button
                  variant="outline"
                  className="w-full h-12 gap-3"
                  onClick={handleGoToRemoteSigner}
                >
                  <Wifi className="w-4 h-4" />
                  Remote Signer
                </Button>
              </div>

              {onCreateAccount && (
                <p className="text-sm text-center text-muted-foreground pt-2">
                  Don&apos;t have an account?{" "}
                  <button
                    type="button"
                    onClick={onCreateAccount}
                    className="text-foreground underline underline-offset-4 hover:text-primary transition-colors"
                  >
                    Create account
                  </button>
                </p>
              )}
            </>
          )}

          {/* ── Secret Key page ── */}
          {page === "secret-key" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleKeyLogin();
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Input
                  id="nsec"
                  type="password"
                  value={nsec}
                  onChange={(e) => {
                    setNsec(e.target.value);
                    if (errors.nsec)
                      setErrors((prev) => ({ ...prev, nsec: undefined }));
                  }}
                  className={`rounded-lg ${
                    errors.nsec
                      ? "border-red-500 focus-visible:ring-red-500"
                      : ""
                  }`}
                  placeholder="nsec1..."
                  autoComplete="off"
                  autoFocus
                />
                {errors.nsec && (
                  <div className="space-y-2">
                    <p role="alert" className="text-sm text-red-500">
                      {errors.nsec}
                    </p>
                    <ManualRetryAction
                      onRetry={handleKeyLogin}
                      busy={isLoading}
                    />
                  </div>
                )}
              </div>

              <div className="flex space-x-2">
                <Button
                  type="submit"
                  size="lg"
                  disabled={isLoading || !nsec.trim()}
                  className="flex-1"
                >
                  {isLoading ? "Verifying..." : "Log in"}
                </Button>

                <input
                  type="file"
                  accept=".txt"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading || isFileLoading}
                  className="px-3"
                  title="Load from file"
                >
                  <Upload className="w-4 h-4" />
                </Button>
              </div>

              {errors.file && (
                <div className="space-y-2 text-center">
                  <p role="alert" className="text-sm text-red-500">
                    {errors.file}
                  </p>
                  <ManualRetryAction
                    label="Choose file again"
                    busy={isLoading || isFileLoading}
                    onRetry={() => {
                      if (!fileInputRef.current) return;
                      fileInputRef.current.value = "";
                      fileInputRef.current.click();
                    }}
                  />
                </div>
              )}
            </form>
          )}

          {/* ── Remote Signer page ── */}
          {page === "remote-signer" && (
            <div className="space-y-4">
              <div className="flex flex-col items-center space-y-4">
                {connectError ? (
                  <div className="flex flex-col items-center space-y-4 py-4">
                    <p className="text-sm text-destructive text-center">
                      {connectError}
                    </p>
                    <Button variant="outline" onClick={() => handleRetry()}>
                      Retry
                    </Button>
                  </div>
                ) : nostrConnectSession ? (
                  <>
                    {!isMobile && (
                      <div className="p-4 bg-white rounded-xl">
                        <QRCodeCanvas
                          value={nostrConnectSession.uri}
                          size={180}
                          level="M"
                        />
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>
                        {isMobile
                          ? "Tap to open your signer app"
                          : "Scan with your signer app"}
                      </span>
                    </div>
                    {isMobile && (
                      <Button
                        className="w-full gap-2 py-6 rounded-full"
                        onClick={handleOpenSignerApp}
                      >
                        <ExternalLink className="w-5 h-5" /> Open Signer App
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size={isMobile ? "default" : "sm"}
                      className={
                        isMobile ? "w-full gap-2 rounded-full" : "gap-2"
                      }
                      onClick={handleCopyUri}
                    >
                      {copied ? (
                        <>
                          <Check className="w-4 h-4" /> Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4" /> Copy URI
                        </>
                      )}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Enter a valid relay port to update the QR code.
                  </p>
                )}
              </div>

              <div className="space-y-3">
                <section
                  aria-label="Remote relays"
                  className="space-y-2 rounded-lg border bg-muted/20 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id="signer-defaults"
                      checked={includeDefaults}
                      disabled={!localSigner}
                      onCheckedChange={(checked) => {
                        const include = checked === true;
                        setIncludeDefaults(include);
                        setShowRelayEditor(include);
                        updateSignerRelays(localSigner, localPort, include);
                      }}
                    />
                    <Label htmlFor="signer-defaults" className="cursor-pointer">
                      Remote relays
                    </Label>
                    {includeDefaults && (
                      <button
                        type="button"
                        aria-label="Edit remote relays"
                        aria-expanded={showRelayEditor}
                        className="ml-auto rounded p-1 focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setShowRelayEditor(!showRelayEditor)}
                      >
                        <ChevronDown
                          className={`size-4 ${showRelayEditor ? "rotate-180" : ""}`}
                        />
                      </button>
                    )}
                  </div>
                  {includeDefaults && !showRelayEditor && (
                    <p className="pl-7 text-xs leading-relaxed text-muted-foreground break-words">
                      {otherRelays
                        .map((relay) =>
                          relay.replace(/^wss?:\/\//, "").replace(/\/$/, ""),
                        )
                        .join(", ")}
                    </p>
                  )}
                  {includeDefaults && showRelayEditor && (
                    <div className="space-y-2 pl-7">
                      {otherRelays.map((relay) => (
                        <div
                          key={relay}
                          className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {relay}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${relay}`}
                            disabled={!localSigner && otherRelays.length === 1}
                            className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() =>
                              handleRelayChange(
                                otherRelays.filter((r) => r !== relay),
                              )
                            }
                          >
                            <X className="size-4" />
                          </button>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Input
                          aria-label="Add signer relay URL"
                          placeholder="wss://relay.example.com"
                          value={newRelayInput}
                          onChange={(event) =>
                            setNewRelayInput(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && newRelayInput.trim()) {
                              event.preventDefault();
                              addSignerRelay();
                            }
                          }}
                          className="min-w-0 h-8 font-mono text-xs"
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label="Add relay"
                          disabled={!newRelayInput.trim()}
                          onClick={addSignerRelay}
                        >
                          <Plus className="size-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
                <section
                  aria-label="Local signer relay"
                  className="space-y-2 rounded-lg border bg-muted/20 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id="local-signer"
                      checked={localSigner}
                      onCheckedChange={(checked) => {
                        const local = checked === true;
                        setLocalSigner(local);
                        setIncludeDefaults(!local);
                        setShowRelayEditor(false);
                        const others = otherRelays.length
                          ? otherRelays
                          : defaultNostrConnectRelays.getValue();
                        setOtherRelays(others);
                        updateSignerRelays(local, localPort, !local, others);
                      }}
                    />
                    <Label htmlFor="local-signer" className="cursor-pointer">
                      Local signer relay
                    </Label>
                  </div>
                  {localSigner && (
                    <div className="space-y-2 pl-7">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-muted-foreground">
                          localhost:
                        </span>
                        <Input
                          aria-label="Local relay port"
                          inputMode="numeric"
                          value={localPort}
                          onChange={(event) => {
                            const port = event.target.value;
                            setLocalPort(port);
                            updateSignerRelays(true, port, includeDefaults);
                          }}
                          className="min-w-0 h-8 font-mono"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Your browser may ask for permission.
                      </p>
                    </div>
                  )}
                </section>
                {localError && (
                  <p role="alert" className="text-sm text-destructive">
                    {localError}
                  </p>
                )}
              </div>

              {/* Manual bunker:// input — collapsible */}
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setShowBunkerInput(!showBunkerInput)}
                  className="flex items-center justify-center gap-2 w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
                >
                  <span>Enter bunker URI manually</span>
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${showBunkerInput ? "rotate-180" : ""}`}
                  />
                </button>

                {showBunkerInput && (
                  <div className="space-y-3 mt-3">
                    <div className="space-y-2">
                      <Input
                        id="connectBunkerUri"
                        value={bunkerUri}
                        onChange={(e) => {
                          setBunkerUri(e.target.value);
                          if (errors.bunker)
                            setErrors((prev) => ({
                              ...prev,
                              bunker: undefined,
                            }));
                        }}
                        className="rounded-lg border-gray-300 dark:border-gray-700 focus-visible:ring-primary text-sm"
                        placeholder="bunker://"
                        autoComplete="off"
                      />
                      {bunkerUri && !validateBunkerUri(bunkerUri) && (
                        <p className="text-red-500 text-xs">
                          Invalid bunker URI format
                        </p>
                      )}
                      {errors.bunker && (
                        <div className="space-y-2">
                          <p role="alert" className="text-sm text-red-500">
                            {errors.bunker}
                          </p>
                          <ManualRetryAction
                            onRetry={handleBunkerLogin}
                            busy={isLoading}
                          />
                        </div>
                      )}
                    </div>

                    {relaysFromUri(bunkerUri).some((relay) =>
                      localEndpoint(relay),
                    ) && (
                      <p className="text-sm text-muted-foreground">
                        This signer uses a local relay. Your browser may ask for
                        permission when you connect.
                      </p>
                    )}
                    <Button
                      className="w-full rounded-full py-4"
                      variant="outline"
                      onClick={handleBunkerLogin}
                      disabled={
                        isLoading ||
                        !bunkerUri.trim() ||
                        !validateBunkerUri(bunkerUri)
                      }
                    >
                      {isLoading ? "Connecting..." : "Connect"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default LoginDialog;
