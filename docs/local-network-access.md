# Local connections

GitWorkshop supports local cache relays, bunker signers, and repository Git and
relay servers on loopback, a LAN, or a VPN. Encountering a local URL is not
permission to contact it. Browser permission and app approval are separate.

## User experience

- **Visitors:** browser storage works immediately. No cache discovery or cache
  prompt, even if the browser already granted local access.
- **Logged-in users, including restored sessions:** show a non-blocking “Allow access to local services?” notice when no discovery preference is saved, with
  **Not now / Allow**. It does not take focus or occupy the signer/server approval queue. Remember either choice in this browser. An injected
  native/extension cache provider suppresses this offer. Settings can change it. Both choices dismiss notices in other open tabs; enabling or disabling also updates their cache lifecycle. Discovery currently checks only `localhost:4869`. If the first approved check finds no relay, show “No local relay found. We’ll look again next time.” for five seconds. Later visits and other tabs retry quietly; browser denial is described separately.
- **Local signer relay:** the checkbox sits below the QR and Copy URI controls in the Remote Signer dialog. Remote relays appears first with its checkbox, hostname summary, and expandable editor in one wrapper. Local signer relay follows in a matching wrapper. Selecting it uses localhost:7777 and unchecks Remote relays. Editing a valid port updates the QR and URI immediately; invalid ports suspend the session without hiding the controls. Checking Remote relays includes them and expands their editor. These explicit transport selections approve their endpoints without a second app dialog; browser permission still applies.
- **Bunker login:** submitting Connect approves the URI’s explicit relay endpoints. Local URLs have an inline browser-permission explanation. Browser denial is still enforced.
- **Adding a relay or GRASP server:** an unapproved local origin
  opens “Connect to this local server?” with its address and purpose. Only
  Continue approves access, after which the original action continues. Merely
  typing, selecting or saving a draft does not approve access.
- **Repository Git reads:** an unapproved local mirror waits behind “Local
  connection paused”, without opening a modal over working public alternatives.
  Opening that control shows the Git-specific explanation; Continue resumes the
  waiting operation, including before creating private Git credentials.
  Cancellation follows the owning operation's AbortSignal.
- **Background relay discovery / restored signers:** blocked locally; show
  “Local connection paused”. Opening it shows the same explanation. Existing
  relay reconnect behavior resumes after approval; exhausted reads and signing
  remain manually retryable at their original controls. Public mirrors continue.
- **Browser denial:** the app explains how to change site permissions. Generic
  connection failure is not interpreted as permission denial. A network outage
  does not erase the user's approval.

There is no internal-server registration form, synthetic HEAD capability probe,
permission-state dashboard, or reload requirement. Local approval stores only
origins, never repository paths, queries or bunker secrets. HTTP/WS share an
approval for the same host/port, as do HTTPS/WSS. The app explanation may precede
a browser-owned prompt; it cannot grant browser permission itself.

## Cache lifecycle

The window.nostrdb polyfill is configured with no startup relay probes. It keeps
IndexedDB as the durable store; injected providers are preserved. After login,
an opted-in cache is checked with a bounded NIP-11 request. If permission is not
available, no request is sent; the initial approval result explains an explicit browser denial. A subsequent browser
prompt can only follow the app's explanation and Continue action.

Disk and network caches have separate APIs and lifetimes. `cacheRequest` reads
only IndexedDB (or the injected provider). The optional local relay streams events
through `optionalLocalCacheRequest`, on its separate unsigned pool. SDK pointer
loaders use `releasingCacheRequest` to merge both sources. After disk completes
(or fails), it emits Applesauce’s `{ type: "release" }` signal to start the
hints/fallback sequence while optional local-cache events continue streaming. A slow local relay therefore cannot delay disk hits, public
fallback starts, or public results. Once the ordinary sequence resolves every
pointer, its optional local request is canceled to release the batch slot.

Tag loaders already run cache/network branches concurrently; their disk and local
streams emit independently. Repository inventory restoration runs separate coherent
disk and local restores, preserving deletions/dependencies-before-roots ordering
without delaying public discovery. Direct disk-only readers, including preflight
and notification storage reads, no longer perform network I/O implicitly.

Optional reads stream events as they arrive, have a ten-second deadline, share
identical concurrent requests, and cancel on unsubscription or logout. Incomplete
coherent repository batches are discarded. A transient failure cools optional
stream requests down for thirty seconds rather than disabling the preference for
the session; a later demand retries. No AUTH signer is attached to this pool.
Concurrent public requests may do more work than the old serial cache-first
approach when the optional relay would have answered everything; that is the
explicit tradeoff for prompt disk results and public fallback.

Discovery's server deadline starts after a reported browser permission decision;
there is no two-second global metadata timeout. Unsupported permission APIs use a
thirty-second discovery bound. Logout/disable cancels pending discovery. Existing
metadata callers retain their own deadlines.

Durable writes stay in browser storage. Only already-admitted public events are
copied to the relay, best effort. Private-event and repository-presence filters
remain in force. Deletion tombstones stay durably readable from browser storage
before startup loaders run. Enabling/disabling the cache does not replace the
live database or require reloading.

The cache choice persists in `local-cache-choice-v1`. Endpoint approval persists
in `local-network-endpoints-v2`, with tab intent in `local-network-session-v2`.
These are browser settings, not account events. An approved endpoint can reconnect
without another app prompt when browser permission is granted or this tab has
already explicitly approved it. With reported prompt permission, a fresh tab
requires the app explanation again. Unsupported permission queries retain the
remembered endpoint choice instead of asking again every tab. Browser denial blocks requests, and permission
changes close tracked local sockets and abort requests awaiting response headers.
Disabling an endpoint does the same. Completed response bodies cannot be revoked.

## Public proxy compatibility

The known-CORS-host list is only a proxy-first optimization. Arbitrary public
forge hosts retain direct-first, proxy-on-CORS-failure behavior. Recognized local
hosts and credential-bearing URLs never go to a public proxy. Authenticated Git
pools already disable proxying entirely. A local approval error cannot trigger a
proxy fallback. Rejection of insecure public HTTP transport can use the configured
HTTPS proxy, without attempting the insecure direct connection. The app does not infer public routability from a hostname or
from HTTPS, nor does it require public hosts to appear on an allowlist.

## Boundaries and browser limitations

Fetch and WebSocket guards install before accounts and relay pools. This covers
dependency-owned traffic, including signer relays and NIP-11 discovery. Known
local destinations include canonical IPv4 loopback, private, link-local and
shared ranges; IPv6 loopback, ULA, link-local and mapped IPv4; localhost names,
`.local`, `.internal`, `.home.arpa`, and single-label hosts. The app origin is
exempt, including development HMR.

Internal HTTP requests set `targetAddressSpace` on supporting browsers and
preserve the caller's redirect and credential modes. Ordinary redirects (including
same-origin path normalization) work again. Local servers still need compatible
CORS/TLS. Fetch hides manual redirects behind opaque responses, so the app cannot
inspect a redirect's Location and selectively approve each hop. The initial URL
is app-approved; redirected destinations remain browser-enforced, as with public
requests. See the [Fetch standard](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque-redirect). WebSockets have no equivalent
`targetAddressSpace` option. Public plaintext addresses are rejected; public
servers should use HTTPS/WSS.

CSP admits HTTP/WS because it cannot express arbitrary private address ranges.
The JavaScript guard is application policy, not an XSS sandbox. Browser permission
and server authentication remain security boundaries.

**The app-first guarantee applies to recognized local destinations.** JavaScript
cannot inspect DNS resolution before connecting. Ordinary HTTPS/WSS hostnames
may resolve privately on a VPN or through rebinding; redirects can also change
address spaces. Those cases, workers, native networking and subresources remain
under browser enforcement. There is no portable API to intercept and replace
every native permission prompt. Requiring approval for all public URLs or disabling
arbitrary proxy fallback would substantially degrade normal use without solving
this limitation. The public proxy must enforce its own destination protections.

See [Chrome's local network access guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access).
We feature-detect granular `loopback-network` / `local-network` permissions, with
a legacy `local-network-access` fallback. Unsupported or timed-out permission
queries mean unknown, not granted. Permission initialization runs in the background;
only local connection attempts wait for it, never public requests or app startup. No deprecated PNA preflight workaround is used.

## Validation

Use a disposable `nak serve` and `nak bunker`, and a production build from an
HTTPS origin. Verify no anonymous cache probes, the post-login cache choice,
remembered opt-out, app-before-network ordering, cancellation, browser-denied
recovery, local signer login, cache disable/logout and public proxy fallback.
Inspect desktop/mobile dialogs and keyboard focus, including nested login.
The commit hook runs types, lint, unit tests and production build; GRASP e2e
validation covers Git/proxy changes separately.

## UX review: introduced versus pre-existing

Regressions introduced by earlier revisions of this PR and corrected here:

- Public-host proxy allowlisting, and custom HTTP transport errors bypassing
  otherwise available proxy fallback.
- Waiting for a local relay before emitting disk cache hits or starting public
  fallback. The two sources now have independent lifetimes.
- A global two-second NIP-11 timeout, forced credential omission, blanket redirect
  rejection, and a global startup wait on browser permission queries.
- Repeated app approval in browsers with no permission-query support, whole-session
  cache disablement on one slow response, and reload-based cache activation.

Pre-existing limitations, deliberately not presented as solved by this PR:

- `CorsProxyManager.toProxyUrl` strips the input scheme. The configured proxy's
  routing determines the upstream protocol; enabling fallback does not guarantee
  support for an HTTP-only forge. Proxy availability, supported hosts and rate
  limits are outside the client. Error-text heuristics cannot reliably separate
  CORS failures from offline, DNS or TLS failures (`isCorsLikeError`,
  `classifyFetchError`). Authenticated Git pools already disable public proxying.
- Browser DNS, CORS, TLS, mixed-content and redirect rules still constrain direct
  access. An ordinary hostname may resolve privately on a VPN. The app does not
  learn that resolution in advance or prove a hostname public before proxying.
- Relay reconnect/backoff, SDK signer timeouts and manual retries for exhausted
  operations existed before this PR. New local approval can expose those paths;
  it is not a general retry/reconnection redesign.
- Repository disk restoration already has a 30-second fallback for a stalled
  IndexedDB read (`observeRepositoryCacheRestore`). Separating the local relay
  removes the added network wait, not the underlying storage stall possibility.

Browser ordering/transport checks and controlled loader checks establish that a
held optional relay does not delay disk results or later public fallback stages.
They are not whole-application performance benchmarks; aggregate request counts,
large repository memory use and real slow-VPN workloads remain unmeasured.
