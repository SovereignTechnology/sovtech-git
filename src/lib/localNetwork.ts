/** Local endpoint intent is independent of the browser's network permission. */
export type AddressSpace = "loopback" | "local";
export type NetworkPermission = PermissionState | "unknown";
export type LocalEndpoint = {
  origin: string;
  space: AddressSpace;
  approved: boolean;
  pending: boolean;
};

const STORAGE_KEY = "local-network-endpoints-v2";
const SESSION_KEY = "local-network-session-v2";
const listeners = new Set<() => void>();
let endpoints: LocalEndpoint[] = [];
let revision = 0;
const sessionApprovals = new Set<string>();
const permissionWatches = new Map<AddressSpace, PermissionStatus>();
const permissions: Record<AddressSpace, NetworkPermission> = {
  loopback: "unknown",
  local: "unknown",
};

/** Use URL's canonical form, including its normalization of unusual IPv4 forms. */
export function addressSpace(raw: string): AddressSpace | undefined {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]")
    return "loopback";
  if (host.startsWith("[")) {
    // URL canonicalizes IPv4-mapped IPv6 to hexadecimal words.
    const mapped = host.match(/^\[::ffff:([\da-f]{1,4}):([\da-f]{1,4})\]$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return addressSpace(
        `http://${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
      );
    }
    if (/^\[(?:f[cd]|fe[89ab])/.test(host) || host === "[::]") return "local";
    return;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 127) return "loopback";
    if (
      a === 0 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      return "local";
    return;
  }
  if (
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  )
    return "local";
}

/** HTTP metadata and WebSocket traffic share consent for the same host/port. */
export function endpointOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Enter an HTTP(S) or WebSocket URL without credentials.");
  url.protocol =
    url.protocol === "ws:"
      ? "http:"
      : url.protocol === "wss:"
        ? "https:"
        : url.protocol;
  return url.origin;
}

export function isAppOrigin(raw: string): boolean {
  try {
    return (
      typeof location !== "undefined" &&
      endpointOrigin(raw) === endpointOrigin(location.href)
    );
  } catch {
    return false;
  }
}

function changed() {
  revision++;
  for (const listener of listeners) listener();
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        endpoints.map(({ origin, space, approved }) => ({
          origin,
          space,
          approved,
        })),
      ),
    );
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([...sessionApprovals]));
  } catch {
    /* In-memory consent still works when storage is unavailable. */
  }
  changed();
}

if (typeof window !== "undefined") {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (Array.isArray(saved) && saved.length) {
      endpoints = saved
        .flatMap((item: unknown): LocalEndpoint[] => {
          if (
            !item ||
            typeof item !== "object" ||
            !("origin" in item) ||
            !("space" in item) ||
            typeof item.origin !== "string" ||
            (item.space !== "local" && item.space !== "loopback")
          )
            return [];
          try {
            return [
              {
                origin: endpointOrigin(item.origin),
                space: item.space,
                approved: "approved" in item && item.approved === true,
                pending: false,
              },
            ];
          } catch {
            return [];
          }
        })
        .slice(0, 100);
    }
    const savedSession: unknown = JSON.parse(
      sessionStorage.getItem(SESSION_KEY) ?? "[]",
    );
    if (Array.isArray(savedSession))
      for (const origin of savedSession) {
        if (
          typeof origin === "string" &&
          endpoints.some((e) => e.origin === origin)
        )
          sessionApprovals.add(origin);
      }
  } catch {
    /* Invalid stored settings are not authority. */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    try {
      const saved: unknown = JSON.parse(event.newValue ?? "[]");
      if (!Array.isArray(saved)) return;
      const next: LocalEndpoint[] = [];
      for (const candidate of saved.slice(0, 100)) {
        const item: unknown = candidate;
        if (
          !item ||
          typeof item !== "object" ||
          !("origin" in item) ||
          !("space" in item) ||
          typeof item.origin !== "string" ||
          (item.space !== "local" && item.space !== "loopback")
        )
          continue;
        next.push({
          origin: endpointOrigin(item.origin),
          space: item.space,
          approved: "approved" in item && item.approved === true,
          pending: false,
        });
      }
      // A removed setting must not erase an internal-host classification while
      // requests to it are still alive in this tab.
      endpoints = [
        ...next,
        ...endpoints
          .filter((e) => !next.some((n) => n.origin === e.origin))
          .map((e) => ({ ...e, approved: false })),
      ];
      for (const origin of sessionApprovals) {
        if (!endpoints.some((e) => e.origin === origin && e.approved))
          sessionApprovals.delete(origin);
      }
      changed();
    } catch {
      /* Ignore malformed cross-tab updates. */
    }
  });
}

export const subscribeLocalNetwork = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const localNetworkRevision = () => revision;
export const localEndpoints = () => endpoints;
export const networkPermission = (space: AddressSpace) => permissions[space];

let permissionReady: Promise<void> | undefined;
let permissionInitialized = false;
export function refreshNetworkPermissions(): Promise<void> {
  return Promise.all(
    (["loopback", "local"] as const).map(async (space) => {
      if (typeof navigator === "undefined" || !navigator.permissions?.query)
        return;
      // Older Chromium implements only the combined name; other browsers may
      // reject every name. Unknown is not equivalent to granted.
      for (const name of [
        `${space === "loopback" ? "loopback" : "local"}-network`,
        "local-network-access",
      ]) {
        try {
          const status = await navigator.permissions.query({
            name: name as PermissionName,
          });
          const update = () => {
            const previousState = permissions[space];
            permissions[space] = status.state;
            if (
              status.state === "denied" ||
              (previousState === "granted" && status.state === "prompt")
            ) {
              for (const endpoint of endpoints.filter((e) => e.space === space))
                sessionApprovals.delete(endpoint.origin);
              persist();
            } else changed();
          };
          const previous = permissionWatches.get(space);
          if (previous) previous.onchange = null;
          permissionWatches.set(space, status);
          update();
          status.onchange = update;
          return;
        } catch {
          /* Try the legacy descriptor. */
        }
      }
    }),
  ).then(() => undefined);
}
export const localNetworkReady = () =>
  (permissionReady ??= new Promise<void>((resolve) => {
    const ready = () => {
      permissionInitialized = true;
      changed();
      resolve();
    };
    const timeout = setTimeout(ready, 1_500);
    void refreshNetworkPermissions().finally(() => {
      clearTimeout(timeout);
      ready();
    });
  }));

export function localEndpoint(raw: string): LocalEndpoint | undefined {
  let origin: string;
  try {
    origin = endpointOrigin(raw);
  } catch {
    return;
  }
  const saved = endpoints.find((e) => e.origin === origin);
  if (saved) return saved;
  const space = addressSpace(raw);
  return space ? { origin, space, approved: false, pending: false } : undefined;
}

/** Also exclude other ports of explicitly marked internal hosts from proxies. */
export function isInternalDestination(raw: string): boolean {
  if (addressSpace(raw)) return true;
  try {
    const host = new URL(raw).hostname;
    return endpoints.some((e) => new URL(e.origin).hostname === host);
  } catch {
    return false;
  }
}

/** Call only from an explicit Connect/Add action; never from discovery. */
export function approveLocalEndpoint(
  raw: string,
  explicitSpace?: AddressSpace,
) {
  const origin = endpointOrigin(raw);
  const space = addressSpace(raw) ?? explicitSpace ?? localEndpoint(raw)?.space;
  if (!space) return;
  endpoints = [
    ...endpoints.filter((e) => e.origin !== origin),
    { origin, space, approved: true, pending: false },
  ];
  sessionApprovals.add(origin);
  dismissed.delete(origin);
  // Inline repository controls must also resume Git requests awaiting consent.
  const callbacks = waiters.get(origin);
  waiters.delete(origin);
  callbacks?.forEach((callback) => callback(true));
  persist();
}

export function forgetLocalEndpoint(origin: string) {
  sessionApprovals.delete(origin);
  endpoints = endpoints.map((e) =>
    e.origin === origin ? { ...e, approved: false, pending: false } : e,
  );
  persist();
}

/** Public Git HTTP may still be reached through its configured HTTPS proxy. */
export class InsecurePublicTransportError extends Error {
  constructor() {
    super("This server needs an HTTPS or WSS address.");
    this.name = "InsecurePublicTransportError";
  }
}

export class LocalNetworkAccessError extends Error {
  constructor(
    public readonly origin: string,
    public readonly reason: "approval" | "permission" | "denied",
  ) {
    super(
      reason === "denied"
        ? `Browser access to ${origin} is blocked. Change local network access in browser site settings, then retry.`
        : `Connection to ${origin} is paused. Choose Continue in Local connections to connect.`,
    );
    this.name = "LocalNetworkAccessError";
  }
}

/** Read permission state without registering a connection attempt. */
export function localAccessAllowed(raw: string): boolean {
  const endpoint = localEndpoint(raw);
  if (!endpoint || isAppOrigin(raw)) return true;
  const permission = permissions[endpoint.space];
  return (
    endpoint.approved &&
    permission !== "denied" &&
    ((permissionInitialized && permission !== "prompt") ||
      sessionApprovals.has(endpoint.origin))
  );
}

/** Synchronous so it can guard the native WebSocket constructor as well. */
export function assertLocalNetworkAccess(
  raw: string,
): LocalEndpoint | undefined {
  const endpoint = localEndpoint(raw);
  if (!endpoint) return;
  if (isAppOrigin(raw)) return;
  const permission = permissions[endpoint.space];
  const reason = !endpoint.approved
    ? "approval"
    : permission === "denied"
      ? "denied"
      : (!permissionInitialized || permission === "prompt") &&
          !sessionApprovals.has(endpoint.origin)
        ? "permission"
        : undefined;
  if (!reason) {
    if (endpoint.pending) {
      endpoints = endpoints.map((e) =>
        e.origin === endpoint.origin ? { ...e, pending: false } : e,
      );
      changed();
    }
    return endpoint;
  }
  if (!endpoints.some((e) => e.origin === endpoint.origin && e.pending)) {
    // Bound untrusted discovery; only origins, never paths, queries or secrets.
    if (endpoints.length < 100 || endpoint.approved) {
      endpoints = [
        ...endpoints.filter((e) => e.origin !== endpoint.origin),
        { ...endpoint, pending: true },
      ];
      changed();
    }
  }
  throw new LocalNetworkAccessError(endpoint.origin, reason);
}

export type ConnectionPurpose = "git" | "relay" | "signer" | "cache";
export type ConnectionPrompt = { origin: string; purpose: ConnectionPurpose };
let prompt: ConnectionPrompt | undefined;
const dismissed = new Set<string>();
const purposes = new Map<string, ConnectionPurpose>();
const waiters = new Map<string, Set<(allowed: boolean) => void>>();
export const connectionPrompt = () => prompt;

/** Open an app-owned explanation; this function never starts network traffic. */
export function showConnectionPrompt(raw: string, purpose?: ConnectionPurpose) {
  const endpoint = localEndpoint(raw);
  if (!endpoint || prompt) return;
  if (!endpoints.some((e) => e.origin === endpoint.origin))
    endpoints = [...endpoints, endpoint];
  prompt = {
    origin: endpoint.origin,
    purpose: purpose ?? purposes.get(endpoint.origin) ?? "relay",
  };
  changed();
}

export function answerConnectionPrompt(allowed: boolean) {
  if (!prompt) return;
  const { origin } = prompt;
  prompt = undefined;
  if (allowed) {
    dismissed.delete(origin);
    approveLocalEndpoint(origin);
  } else {
    dismissed.add(origin);
    forgetLocalEndpoint(origin);
  }
  const callbacks = waiters.get(origin);
  waiters.delete(origin);
  callbacks?.forEach((callback) => callback(allowed));
  changed();
}

/** User actions wait here before connecting or asking a signer. Background
 * discovery fails locally and offers the same explanation without modal spam. */
export async function confirmLocalNetworkAccess(
  raw: string,
  purpose: ConnectionPurpose,
  signal?: AbortSignal,
  interactive = true,
): Promise<boolean> {
  signal?.throwIfAborted();
  await localNetworkReady();
  const origin = localEndpoint(raw)?.origin;
  if (origin) purposes.set(origin, purpose);
  try {
    assertLocalNetworkAccess(raw);
    return true;
  } catch (error) {
    if (!(error instanceof LocalNetworkAccessError)) throw error;
  }
  const endpoint = localEndpoint(raw)!;
  if (!interactive && dismissed.has(endpoint.origin)) return false;
  dismissed.delete(endpoint.origin);
  if (!endpoints.some((e) => e.origin === endpoint.origin)) return false;
  // Background mirrors wait without interrupting working public alternatives.
  // Their owner can abort the wait on navigation. Explicit actions open the box.
  if (interactive) {
    if (prompt && prompt.origin !== endpoint.origin) return false;
    showConnectionPrompt(raw, purpose);
  }
  return new Promise<boolean>((resolve, reject) => {
    const callbacks = waiters.get(endpoint.origin) ?? new Set();
    const finish = (allowed: boolean) => {
      signal?.removeEventListener("abort", abort);
      callbacks.delete(finish);
      resolve(allowed);
    };
    const abort = () => {
      callbacks.delete(finish);
      if (!callbacks.size) {
        waiters.delete(endpoint.origin);
        endpoints = endpoints.map((e) =>
          e.origin === endpoint.origin ? { ...e, pending: false } : e,
        );
        if (prompt?.origin === endpoint.origin) {
          prompt = undefined;
        }
        changed();
      }
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    callbacks.add(finish);
    waiters.set(endpoint.origin, callbacks);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function pendingLocalEndpoints() {
  return endpoints.filter((e) => e.pending);
}

/** A dismissed browser prompt is not a durable grant. Preserve endpoint intent
 * across outages, but require our explanation again if the browser still asks. */
export async function observeLocalConnectionFailure(origin: string) {
  await refreshNetworkPermissions();
  const endpoint = localEndpoint(origin);
  if (endpoint && permissions[endpoint.space] === "prompt") {
    sessionApprovals.delete(endpoint.origin);
    persist();
  }
}
