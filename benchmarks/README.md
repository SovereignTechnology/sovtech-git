# Relay query-budget benchmarks

Measures what a production build of the app actually sends to relays while
navigating a reference repository: REQ frames, bytes of REQ filter JSON,
distinct relay connections, EVENT frames received, and wall-clock timings.
REQ count and filter bytes are the primary budget (near-deterministic client
behaviour); timings run against live public relays and are noisier, so they
are budgeted with absolute ceilings — their job is to catch a 0.4s → 9s
cliff, not a 10% wobble.

## Scenarios

Both scenarios run in one browser session against `vite preview` serving a
fresh production build, in a brand-new browser context (no IndexedDB, no
localStorage, so default settings apply — including outbox relay mode):

1. **Cold load** — navigate straight to the reference repo's Issues tab and
   poll the Issues/PRs tab text (label + streaming open-count badge) until it
   has not changed for 5s.
2. **Warm switch** — from settled Issues, click the PRs tab, measure the
   time until the PRs tab is active and painted, then wait for stability
   again. WebSocket counters for this scenario are the delta from the
   cold-load snapshot.

## Reference repository

The default reference repo is `nostr://danconwaydev.com/gitworkshop` — this
very repository, which has a substantial issue/PR history. Keep using it so
runs stay comparable with `baseline.json`; `--repo` exists for ad-hoc
investigation, not for baseline comparisons.

## Running

```sh
# Nix (recommended) — browsers come from the flake-pinned bundle:
nix develop .#bench --command pnpm bench

# Elsewhere — provision a browser once, then run directly:
npx playwright-core install chromium
pnpm bench
```

Useful flags (see `pnpm bench --help`):

- `--compare benchmarks/baseline.json` — diff the run against the committed
  baseline and exit non-zero on regressions (see "Compare limits").
- `--skip-build` — reuse the existing `dist/` (repeat runs on one commit).
- `--repo <nostr://owner/repo-id>` / `--out <file>` / `--port <port>`.

Each run writes a JSON report to `benchmarks/results/` (gitignored) and
prints a human-readable summary.

## Baseline workflow

`baseline.json` is the median of 3 runs (by cold-load REQ frames) at a known
commit — see its `meta.commit`. Any change to subscription/loader behaviour
must keep `pnpm bench --skip-build --compare benchmarks/baseline.json`
passing; refresh the baseline (same 3-run median procedure) only as a
deliberate, reviewed act, re-deriving the compare limits from the spread of
those runs.

## Compare limits

Query limits are `baseline × (1 + pct) + abs`; timing limits are
`max(baseline × mult, floor)` — an absolute floor, so a sub-second baseline
gets a sensible ceiling instead of a hair-trigger relative one. Limits are
per scenario because the two scenarios no longer have the same shape.

| scenario    | metric               | baseline | limit   | spread over the 3 baseline runs |
| ----------- | -------------------- | -------- | ------- | ------------------------------- |
| cold load   | `reqFrames`          | 1,601    | 2,212   | 1,400 – 1,631                   |
| cold load   | `reqFilterBytes`     | 2.23 MB  | 2.93 MB | 2.11 – 2.36 MB                  |
| cold load   | `distinctRelays`     | 54       | 74      | 54 – 54                         |
| cold load   | `navToTabsVisibleMs` | 1.8s     | 8.0s    | 1.6 – 1.9s                      |
| cold load   | `timeToStableMs`     | 23.6s    | 60.0s   | 17.1 – 36.7s                    |
| warm switch | `reqFrames`          | 9        | 138     | 9 – 89                          |
| warm switch | `reqFilterBytes`     | 3.2 KB   | 47.4 KB | 3.2 – 31.4 KB                   |
| warm switch | `distinctRelays`     | 17       | 26      | 14 – 19                         |
| warm switch | `tabSwitchMs`        | 0.4s     | 2.0s    | 0.4 – 1.6s                      |
| warm switch | `timeToStableMs`     | 0.4s     | 6.0s    | 0.4 – 1.6s                      |

Rationale:

- **Cold load is close to reproducible** — REQ frames varied ±13% of the
  median and filter bytes ±6%. A ~35% band plus a small absolute allowance
  absorbs that, live relay churn, and the reference repo accumulating issues
  and PRs over time. This replaces the previous 2×/3× slack, which existed
  because settle-gated measurement let reconnect churn pile up before
  additive subscriptions landed.
- **Warm switch is now single-digit REQs**, so its limits are absolute
  rather than relative: percentages of a median of 9 mean nothing. One
  baseline run spent ~80 extra REQs because the tail of cold-load identity
  enrichment reconnected onto four relays just after the scenario boundary,
  which is the variance the `abs` allowance covers. The ceilings still fail
  an order of magnitude below the pre-additive-subscription behaviour
  (636 REQs / 1.29 MB of filter JSON for the same tab switch).
- **`distinctRelays` keeps its tight limit** (+30%, +3). It was identical
  across all three cold runs; the slack only covers live NIP-65 outbox
  drift, and in the warm scenario the fact that it counts relays with _any_
  delta counter.
- **Timings are budgeted, not just reported.** The warm tab switch is a
  store read and must never quietly return to seconds: it fails above 2s,
  and warm settle above 6s — generous against live-relay latency noise, but
  far below the ~9s both took before. Cold load fails above 8s to first
  paint of the tabs and 60s to settle, which catches a cliff without
  reacting to a slow relay day.

A scenario that never settles within its timeout fails regardless of counts.

## Toolchain notes

The default devShell deliberately omits the ~1 GB Chromium bundle; only the
`bench` shell carries it. The `playwright-core` devDependency is pinned to the
exact version of `pkgs.playwright-driver` in `flake.nix` so the browser
revisions match — bump them together.

The benchmark is never part of pre-commit, `pnpm test`, or CI.

## Application profiling

Build with `pnpm build:profile`, then serve using
`pnpm exec vite preview --outDir dist-perf`. Normal builds do not install these
probes. In the coding-agent VM use an isolated `browser-session` lease and close
it afterward. The browser console exposes:

```js
window.__gwPerf.json(); // Export the report as JSON.
window.__gwPerf.reset(); // Reset aggregate counters, not the page-lifetime waterfall.
window.__gwPerf.renders(true); // Optional React attribution.
```

For the React profiling bundle use `VITE_PROFILE_REACT=1 pnpm build:profile`.
Keep probe settings identical across comparisons and confirm behavior in a
normal production build. Save raw captures under ignored `perf-reports/`.
Record the built commit plus dirty diff, browser/device, URL, cache state,
probe settings and observable readiness condition. Rebuild after source changes.

Use a fresh context for cold runs (clearing cookies does not clear IndexedDB).
Use the same context for warm runs. Compare controlled equal-data fixtures for
application cost, and repeated alternating-order live runs for external relay
behavior. Record missing data, refusals and timeouts as incomplete/failed runs;
a quiet DOM or EOSE alone is not global historical completeness. Fixed-duration
windows measure continuing work; navigation checks need bounded readiness waits.

Long frames are not CPU utilization; React base durations are estimates;
overlapping cache-query times are not serial elapsed time; text lengths are
characters rather than compressed bytes. Relay response times include network,
server and browser delays. Heap snapshots without controlled GC do not prove
retained-memory equivalence. NIP-77 negotiation is not currently attributed.

## Controlled pagination comparisons

The manual harnesses run separately from pre-commit and the query-budget suite.
They use synthetic events and never publish. No personal account is needed.

```sh
node benchmarks/pagination-comparison.mjs <baseline-tree> <comparison-tree> <candidate-tree>
PAGINATION_SCENARIOS=equal-data PAGINATION_REPORT=equal-data.json \
  node benchmarks/pagination-comparison.mjs <baseline-tree> <comparison-tree> <candidate-tree>
PAGINATION_SCENARIOS=notifications,notifications-slow PAGINATION_REPORT=notifications.json \
  node benchmarks/pagination-comparison.mjs <baseline-tree> <comparison-tree> <candidate-tree>
```

All trees use the same installed dependencies. The harness bundles actual source
loaders, exercises the EventStore, and writes to
`perf-reports/pagination-performance/`. Node CPU includes the fixture matcher;
it excludes React, IndexedDB, WebSocket decoding and real network transport.
Observation-window counts do not prove that a history load finished.

For browser replay, build each revision and serve it on its own local port.
Start `node benchmarks/pagination-browser-server.mjs` from the reporting tree.
Write `perf-reports/pagination-performance/browser-config.json`, for example:

```json
{
  "port": 4173,
  "revision": "candidate",
  "scenario": "search",
  "name": "search-candidate",
  "live": false,
  "observationMs": 5000
}
```

Allocate a `browser-session` lease, open a local preview through that lease, and
run `node benchmarks/pagination-browser-run.mjs <lease>`. Close the lease and
owned preview/fixture servers afterward. Scenarios are `repo`, `notifications`
and `search`; optional `latencyMs` and `cap` control the synthetic relay.
`probeInteraction` checks a read-only notification grouping change during load.
`live:true` uses real relay traffic and needs an appropriately scoped browser
lease; use fresh contexts and preserve relay/network failures in comparisons.

Keep captured datasets and raw run reports outside tracked source (for example,
in an external artifact archive or ignored `perf-reports/`). Record the workload,
high-level results, interpretation and limitations in the relevant commit message.
Run reports do not replace the maintained baseline for `pnpm bench --compare`.

## Dependency comparisons

Use two clean checkouts with their **own** `pnpm install --frozen-lockfile` and
production/profile builds. Sharing installed dependencies measures source changes,
not a dependency upgrade. The comparison refuses tracked modifications and records
the commit, tree, lockfile hash and installed core/relay versions.

```sh
node --expose-gc benchmarks/dependency-upgrade.mjs <v6-tree> <v7-tree> store
node --expose-gc benchmarks/dependency-upgrade.mjs <v6-tree> <v7-tree> transport
node --expose-gc benchmarks/dependency-upgrade.mjs <v6-tree> <v7-tree> bundles
```

The store comparison uses ten alternating pairs after two warmups per variant.
It checks event identities after each sample and measures kind/tag timelines,
multiple subscribers, duplicate delivery, synchronous reads and replaceable
updates. Verification is disabled to match the application store policy. The
100-read scenarios repeat a local query to stabilize timing; they do not model
100 user actions or relay requests. They report the entire loop, not one read.
Node CPU is not browser
CPU. Between-sample GC reduces carryover but does not make this a memory benchmark.

The transport comparison uses real local WebSockets and the default request
deadline, with reconnect disabled. It includes a 35-second stream; its scheduled
delays are the behavior under test. This checks lifecycle outcomes, not statistical
network performance, authentication or the application's retry amplification.
The server uses `ws` from the existing `jsdom` dependency. Bundle totals include
lazy JS/CSS chunks and therefore are not initial page transfer sizes.

For application comparisons use the browser replay above with each checkout's
preview port, alternating versions and fresh contexts. `warmReload:true` adds a
same-context repository reload; `probeInitialInteraction:true` exercises a local
notification grouping change immediately after readiness. Interaction timings
include browser automation and two animation frames, not just handler CPU or INP.
Captured event-ID hashes permit equal-data checks. Heap readings remain
GC-sensitive snapshots. Use production builds for primary results and identical
profiling builds for supporting attribution. Record every config and failure;
fixed observation windows do not establish completion.

## Fixed public repository replay

Supply a captured public repository snapshot with `BENCH_CORPUS`. The gzip JSON
contains an `events` array; preserve capture provenance, relay failures and
bounded-cursor limitations with the artifact. A snapshot is not a complete
archive of every relay. Keep the dataset outside tracked source.

Run the actual issue/PR models and populated-store queries with each checkout's
own installed dependencies:

```sh
export BENCH_CORPUS=/path/to/repository-snapshot.json.gz
node --expose-gc benchmarks/repository-models.mjs <v6-tree> <unpatched-v7-tree> <patched-v7-tree>
BENCH_STREAMING=1 node --expose-gc benchmarks/repository-models.mjs <v6-tree> <patched-before-coalescing> <coalesced-tree>
```

For production browser replay, start the fixture server with
the same `BENCH_CORPUS` environment variable, then use the
existing browser runner with `retainEventIds: true` and
`probeRepoInteraction: true`. Set both `cap` and `defaultLimit` to 500 to
replay ngit-grasp's documented result cap and omitted-limit default; the runner
otherwise defaults omitted limits to 100. Controlled replay selects repo relay
mode and mirrors the snapshot across intercepted relays. It measures event-shape
costs with fixed topology, not the traffic distribution of real outboxes.
The interaction timer starts before Playwright fills the issue search input with
a nonmatching string, waits for the empty-result message, then waits for two
animation frames. Clearing the input happens after the timed interval. This is
an automated interaction duration including automation, scheduling and rendering;
the frame callbacks allow a rendering opportunity but do not prove physical
presentation. It is not handler CPU, INP, a freeze duration or history completion.
The action runs after the first issue appears, so versions can be processing
different event volumes and different stages of loading. A comparison against
missing-history behavior measures the overall user-visible tradeoff, not an
isolated dependency regression. More work can explain a slower action, but does
not establish that the delay is unavoidable. Fixed observation
windows measure ongoing work; they do not prove exhaustion. The 100-result cap
also exposes the separate, unchanged root-discovery cap in both versions.

For live query-budget validation in the isolated browser, the same fixture
server receives reports and the production preview must already be running:

```sh
node benchmarks/budget-browser-session.mjs <lease> <preview-port> <report-label>
```

This adapter reuses the scenario functions and comparison limits from
`bench.mjs`; it substitutes the lease's timer for Node's timer in bounded
polling. It exits non-zero on scenario errors or budget failures, preserving the report.
Allow the app's actual public relay/NIP-05 origins when creating the lease.
