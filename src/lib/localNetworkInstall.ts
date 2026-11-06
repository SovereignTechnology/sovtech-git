import {
  assertLocalNetworkAccess,
  InsecurePublicTransportError,
  addressSpace,
  isAppOrigin,
  localEndpoint,
  localNetworkReady,
  subscribeLocalNetwork,
  observeLocalConnectionFailure,
} from "./localNetwork";

// This boundary deliberately includes dependency-owned pools and metadata
// fetches. It is application policy, not an XSS sandbox or a DNS firewall.
// Install before loading the cache polyfill, accounts, or relay singletons.
const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeWebSocket = globalThis.WebSocket;
function checkTransport(url: URL) {
  if (addressSpace(url.href) && (url.username || url.password)) {
    throw new Error("Use a local server URL without embedded credentials.");
  }
  if (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    !localEndpoint(url.href) &&
    !isAppOrigin(url.href)
  ) {
    throw new InsecurePublicTransportError();
  }
  return assertLocalNetworkAccess(url.href);
}
const sockets = new Map<WebSocket, string>();
const requests = new Map<AbortController, string>();

globalThis.fetch = async (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, location.href);
  if (localEndpoint(url.href) && !isAppOrigin(url.href))
    await localNetworkReady();
  const endpoint = checkTransport(url);
  if (!endpoint) return nativeFetch(input, init);
  const request = new Request(input, init);
  // Preserve the caller's redirect and credential modes. Fetch does not expose
  // cross-origin Location headers in manual mode; redirect enforcement belongs
  // to the browser, as for public requests. Consent covers the initial origin.
  // targetAddressSpace permits local HTTP from a secure context when supported.
  const localInit: RequestInit & { targetAddressSpace: "local" | "loopback" } =
    {
      targetAddressSpace: endpoint.space,
    };
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  requests.set(controller, url.href);
  try {
    return await nativeFetch(request, {
      ...localInit,
      signal: controller.signal,
    });
  } catch (error) {
    void observeLocalConnectionFailure(endpoint.origin);
    throw error;
  } finally {
    requests.delete(controller);
    request.signal.removeEventListener("abort", abort);
  }
};

if (NativeWebSocket) {
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const endpoint = checkTransport(new URL(url, location.href));
      super(url, protocols);
      if (endpoint) {
        sockets.set(this, String(url));
        this.addEventListener(
          "error",
          () => {
            void observeLocalConnectionFailure(endpoint.origin);
          },
          { once: true },
        );
        this.addEventListener("close", () => sockets.delete(this), {
          once: true,
        });
      }
    }
  };
}

subscribeLocalNetwork(() => {
  for (const [controller, url] of requests) {
    try {
      assertLocalNetworkAccess(url);
    } catch {
      requests.delete(controller);
      controller.abort(new Error("Local access paused"));
    }
  }
  for (const [socket, url] of sockets) {
    try {
      assertLocalNetworkAccess(url);
    } catch {
      sockets.delete(socket);
      socket.close(1000, "Local access paused");
    }
  }
});

// Warm permission state without delaying public networking or app rendering.
void localNetworkReady();
