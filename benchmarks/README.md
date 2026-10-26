# Relay query-budget benchmarks

Measures what a production build of the app actually sends to relays while
navigating a reference repository: REQ frames, bytes of REQ filter JSON,
distinct relay connections, EVENT frames received, and wall-clock timings.
REQ count and filter bytes are the primary budget (near-deterministic client
behaviour); timings run against live public relays and are noisier, so they
are budgeted with absolute ceilings — their job is to catch a 0.4s → 9s
cliff, not a 10% wobble.

## UX priorities and tradeoffs

Use these priorities when assessing performance changes, including effects that
the current benchmarks do not measure. A faster selected comment is useful, but
does not justify quietly delaying repository counts, statuses, another page or
live updates. This guidance records product priorities; it does not approve a
particular scheduler, cache design or presentation delay.

### What should become useful first

- **Issue/PR detail:** accurate essentials first: status, re-titles and current
  PR updates/revision; then the cover letter/body, first comment, and remaining
  discussion. This is a preference for useful progress, not a requirement to
  serialise all loading or wait for complete history before showing content.
  Empty conversations must also become useful promptly. PR updates are
  user-facing essentials even though the current loader groups them with
  comments and CI.
- **Git review:** commits and changed files are part of readiness too. Their
  exact priority relative to conversation content remains a design decision;
  explicitly opening those tabs makes them foreground work. Keep the displayed
  revision, diff, target branch and CI association coherent. A Git-stubbed
  conversation replay cannot establish review readiness.
- **Repository Issues/PRs views:** show the newest work promptly and reach
  accurate open membership and counts quickly. Reduce items appearing and then
  disappearing as status/revision evidence arrives, and disruptive reordering
  as newer activity is discovered. A brief initial settling period may be a
  reasonable tradeoff, but must be weighed against delaying new work. Do not
  withhold correctness updates merely to keep ordering still.
- **Return visits:** frequently visited repositories should become useful
  quickly while reconciling new items, statuses and activity. Investigate reuse
  of existing event/Git caches before adding another cache. Cached state is not
  proof of current state; repository-view caching remains a proposal.
- **Throughout loading:** typing, clicking, scrolling, navigation and cancelling
  should remain responsive, preserving drafts and the reader's position.
  Background progress matters because the next navigation can make it
  foreground. Preserve subsequent live updates and appropriate resource release
  across repeated navigation and longer sessions.

### Reason about what the benchmark misses

For a performance change, briefly record in the PR or commit:

1. Which user outcome improves, and why the change should improve it.
2. Where work moves or is deferred, who may wait longer, and what happens if the
   user navigates there before loading finishes.
3. What the evidence establishes, what remains unmeasured, and why the proposed
   tradeoff is acceptable. Label inference separately from measured results.

For example, immediate detail queries may compete with repository essentials;
coalescing list updates may delay new items; root-first delivery may show items
before their classification is known; caching may expose stale state. Consider
search, notifications, pagination, Git work and authenticated/outbox/private
paths when they share the changed resources. Slow, capped, unavailable and
partially overlapping relays can change the tradeoff. It is reasonable to explain
an unaffected path from its ownership and dependencies rather than benchmark it.

Preserve resilience, rate limiting, deletion detection, reciprocal maintainer
authorization, private isolation and subscription ownership unless a separately
justified change is proposed. Faster incomplete loading is not an efficiency win.
Shared owners may intentionally remain active after a child page unmounts.

### Keep measurement bounded

Reuse the existing harness and add only the evidence needed for the decision.
Useful focal journeys for scheduling/cache work are cold detail entry followed
by list navigation **during** loading, and a return to a previously visited
repository after new activity. These are priorities for targeted extensions,
not claims that the current harness fully covers them or a mandate to build a
new suite. Add checks for other paths when the change puts them at risk; do not
create an exhaustive benchmark matrix.

Correctness, authority, deletion handling and input preservation are guardrails.
Judge latency alongside repository progress and interaction responsiveness.
Request counts, bytes, long tasks and frame gaps help explain costs; they cannot
alone establish a better experience. Keep existing benchmark gates unless
explicitly reviewed, and do not invent universal timing thresholds or combine
foreground gains and background regressions into one score.

Event receipt is not correct rendered state. Matching counts can conceal wrong
membership; compare identities and states where relevant. EOSE, silence and
stable counts do not prove completeness. A full-snapshot run through production
models is a useful query-coverage reference, not independent validation of those
models. DOM anchors plus animation frames do not prove visible pixels. Preserve
missing-data and timeout outcomes, state the fixture/relay/cache scope, and avoid
generalising mirrored-relay or Git-stubbed replay to live usage.

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

The live relay benchmark is never part of pre-commit, `pnpm test`, or automatic CI.
The separate controlled UI job below runs on demand.

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

For the compiled matchers used by live timelines (separate from stored-query
planning), compare two installed v7 checkouts:

```sh
BENCH_CORPUS=/path/to/repository-snapshot.json.gz node benchmarks/compiled-filters.mjs <before-tree>/node_modules/applesauce-core/dist/helpers/filter.js <after-tree>/node_modules/applesauce-core/dist/helpers/filter.js
```

This overwrites ignored `perf-reports/compiled-filters.json` (override with
`BENCH_REPORT`). Nine alternating-order rounds compare single-root, 20-root
and all-root comment filters. Each timed sample replays the corpus 50 times
to measure matcher throughput; this repetition is not a user journey. Exact
matching identities are checked against the raw matcher, compilation is timed
separately, and event tag caches are warmed before timing. Module source hashes
reject accidental comparisons against a shared, identical installation. Pair this diagnostic
with browser journeys before drawing conclusions about responsiveness.

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

## On-demand UI benchmark artifacts

`.ngit/nix/workflows/benchmark.yaml` runs only when explicitly requested:

```sh
ngit --repo origin ci trigger <coordinator-npub> <commit> \
  --workflow .ngit/nix/workflows/benchmark.yaml --json
```

The coordinator's manual-run policy requires a confirmed maintainer (or a key
explicitly accepted by its operator) and a commit reachable from a published
repository-state ref. Publishing a PR revision alone does not satisfy that ref
requirement. For PR-only heads, use the local lease driver; request the remote
run after the commit is published on an eligible branch. A CLI response saying
`triggered` means the request was published, not that a worker accepted it.

The job builds that exact revision with frozen dependencies and runs one discarded
warmup followed by five fresh desktop browser contexts. It uses the deterministic
synthetic repository, blocks external HTTP, intercepts all relay WebSockets, and
publishes raw reports plus `summary.json` as the signed run's `replay` artifact.
It does not publish events or require an account. Locally, open a dedicated
`browser-session` lease and pass its ID to `node benchmarks/ci-replay.mjs <lease>`
to exercise the same driver against an already-built `dist/`; ports 4173 and 4190
must be free. Close the lease afterward. Browser binaries use the same
flake-pinned Playwright bundle as the benchmark shell. This is separate from the
live relay query-budget benchmark and the ordinary CI checks.

Request runs before and after a performance-sensitive change, on the same worker
resource configuration. Keep their immutable artifact links in the PR and the
numerical conclusion in the commit message. A latest-result link is a convenience,
not a replacement for the referenced evidence. Do not commit downloaded reports
or automatically overwrite `baseline.json`. Compare downloaded summaries with:

```sh
node benchmarks/replay-report.mjs before/summary.json after/summary.json \
  perf-reports/comparison.json
```

Dataset fingerprints cover unsigned event content because synthetic Schnorr
signatures contain random auxiliary data. The comparison refuses mismatched
browser versions, dataset fingerprints, event IDs or
benchmark harnesses. Carry the same benchmark-only change onto an older revision
when it lacks the harness, recording both the measured application commit and
that benchmark commit. Dependency lock hashes may differ intentionally. Match
worker resources too; scheduling noise remains even on identical workers.
Timing distributions are evidence for review, not a universal percentage gate.
Missing data, page failures and inconsistent samples fail the job.

`matchedData: true` in the local browser config returns all events matching each
filter, disregarding result limits. After requests have drained and no replay
response has been delivered for one second, it measures filtering the issue list.
This deliberately removes pagination truncation from the workload. It retains
filter semantics, but is not a realistic capped relay or a pagination correctness
test. Reports verify that the received event set does not grow during the action,
and comparisons require identical sets across versions. The timer includes
Playwright filling, the empty-result DOM update and two animation frames; it is
not INP. First-content and startup long-task measurements remain descriptive
because delivery order can differ. Use the capped replay separately to assess
history recovery and interactions during loading. The real gitworkshop capture
can be supplied locally via `BENCH_CORPUS`; CI needs no external dataset download.

## Cold detail-entry scheduling experiment

The `direct-entry-browser-*` tools compare concurrent repository loading with
an experimental selected-item head start. They use a production bundle,
replay a captured public repository corpus locally, and never publish or
contact live relays. The experimental gate exists only in the benchmark
bundle; do not deploy `perf-reports/direct-entry/dist`.

```sh
node benchmarks/direct-entry-browser-build.mjs
# Separate terminals for the fixture receiver and preview server:
BENCH_CORPUS=/absolute/path/to/repository.json.gz node benchmarks/direct-entry-browser-server.mjs
pnpm exec vite preview --host 127.0.0.1 --port 4192 --strictPort --outDir perf-reports/direct-entry/dist

lease="$(browser-session new --label direct-entry)"
browser-session playwright "$lease" open about:blank
```

Write `perf-reports/direct-entry/config.json` with the selected root event ID:

```json
{
  "itemId": "<64-character PR or issue event ID in the corpus>",
  "mode": "baseline",
  "port": 4192,
  "label": "baseline-1",
  "cap": 100,
  "latencyMs": 20
}
```

Run `node benchmarks/direct-entry-browser-run.mjs "$lease"`. Repeat with
`"mode": "priority"` and a different label, alternating order for at least
three pairs. Each run creates a fresh browser context. Close the lease with
`browser-session close "$lease"` when finished. Reports stay in the ignored
`perf-reports/direct-entry/` directory. The corpus format matches the captured
fixtures used by the pagination benchmark (`owner`, `coordinate`, `events`).

Priority mode holds new base and supplemental repository owners until the
first selected comment reaches the DOM and two animation frames pass, with a
three-second fallback. It is a hypothesis probe, not a production readiness
policy. Existing owner subscriptions are never restarted by the gate. Empty
threads exercise the fallback. Optional `"navigate": true` checks PR-list/back
navigation after the observation window; `"snapshot"` accepts a screenshot
path within the browser lease's artifact directory.

Reports include selected-title/comment DOM milestones, following paint
opportunities, long tasks, frame gaps, request filters and received event IDs
over a nominal twelve-second startup window (`observationMs` can extend it).
`observedUntil` records the actual cutoff: a busy main thread can delay sampling. A double animation frame is not
proof of pixel presentation; comments may be below the viewport. Compare
received IDs before interpreting CPU totals as equal-work measurements, and
compare selected-content latency separately from background progress. Relay
caps and transport latency are controlled parameters, not measured properties
of public relays. Git HTTP and other external HTTP responses are stubbed, so
this measures the Nostr conversation path rather than git diff/merge readiness.

For a real IndexedDB reload, set `"cacheReload": true` and optionally
`"entrySuffix": "/prs"` (or `"/issues"`). The harness seeds captured roots,
statuses, updates, labels and deletions through the app's cache backend, waits
for exact-ID reads and root-kind filter visibility, then opens a fresh document with an empty EventStore. It
uses the IndexedDB fallback rather than an optional host local relay. This mode
cannot be combined with journey, curation or full-snapshot injection modes.
Reports include the number of seeded events, initial list DOM transitions,
and first-list paint opportunities. These are animation-frame opportunities,
not proof of pixel presentation. Older app bundles also expose a cached-banner
paint marker.
Compare exact final repository membership and statuses as well as convergence,
traffic and responsiveness: a lower transfer count with missing visible items
is a regression. Delivery coverage describes network receipts, not cached bodies.

Set `"cacheReload": "natural"` to visit the list for a 60-second observation
window before reloading, without injecting event bodies. Reports preserve the
pre-reload repository model and the number of cached essential events under
`cacheReload.population`. This exercises the app's admission/write/read cycle;
the observation window is not a completeness assertion. Compare pre- and
post-reload exact membership/statuses, and retain partial outcomes.

### Query strategies and user-facing outcomes

Set `strategy` independently of `mode` (keep `mode: "baseline"` when isolating
query strategy):

| Strategy           | Detail-page demand                                | Root thread                      | Recursive thread |
| ------------------ | ------------------------------------------------- | -------------------------------- | ---------------- |
| `shared` (default) | Shared essentials and focused comments/updates/CI | 500 ms buffer                    | 500 ms buffer    |
| `thread-only`      | Shared essentials                                 | 500 ms buffer                    | 500 ms buffer    |
| `one-shot`         | Shared essentials plus immediate focused preview  | 500 ms buffer                    | 500 ms buffer    |
| `immediate-root`   | Shared essentials                                 | Immediate, one pointer per batch | 500 ms buffer    |

All variants retain repository list owners, essential-deletion queries, full
thread history and resilient relay handling. “Thread-only” removes **detail's**
focused comment demand; repository demand still exists. The one-shot preview
uses `resilientRequest`, closes each relay at EOSE, and cancels any remaining
work after three seconds. It neither paginates nor establishes completeness;
the persistent thread handles history and subsequent events. Immediate-root
uses the existing paginated loader with `bufferSize: 1`, preserving history
semantics without a zero-duration repeating buffer timer. These are benchmark
injections, not production changes or approved replacements for shared ownership.

`direct-entry-thread-suite.json` isolates removal of detail's focused demand
using the authored fixture's cold-navigation and warm-return journeys, with
three alternating pairs. Run it with `direct-entry-browser-suite.mjs` and a
fixture server started without `BENCH_CORPUS`. Both strategies retain the same
thread buffer; this does not evaluate immediate root scheduling or a one-shot
preview. Pair it with uninterrupted captured-data detail runs to check PR
revision and comment readiness under repository load. A lower request count
alone is not a reason to remove focused loading.

Reports distinguish:

- First/all selected NIP-22 comment DOM anchors and subsequent paint
  opportunities. These do not assert on-screen visibility or include legacy replies.
- First/all captured selected PR update and essential event **receipt**. Essentials
  here are statuses, labels and root deletions; receipt does not establish their
  authority, final rendered status, or deletion-of-essential coverage.
- All captured NIP-22 comments referencing captured issue/PR/patch roots received.
  Coverage reports expected counts, missing IDs and completion times. Empty sets
  are `not-applicable`; deadlines leave incomplete sets explicitly censored.
- The navigation badge's open-PR count transitions, compared with a full-snapshot
  reference. `correctThroughEndFrom` is the start of the final uninterrupted
  matching period within the observation window, not its first accidental match.
  Matching a number alone can still be coincidental when inputs are incomplete;
  it does not prove that the exact open-PR membership is correct.
- Request count/filters, event bytes/duplicates, unique event IDs, long tasks and
  frame gaps. Compare exact received sets before calling CPU totals equal-work.

`fullSnapshotReference: true` preloads the complete fixture into the real
EventStore before application startup. The normal resolver, role history,
status/deletion handling and PR grouping compute the reference badge. This
provides a reference for query completeness, **not** independent proof of those domain
rules. The DOM count probe currently requires a visible positive badge; it fails
rather than treating an absent/loading badge as zero. Reference runs are excluded from performance comparisons. A snapshot
cannot prove completeness beyond the events that were captured.

Run a repeatable suite with an existing browser-session lease:

```sh
node benchmarks/direct-entry-browser-suite.mjs "$lease" /absolute/path/to/suite.json
```

Example suite (choose real IDs from the local fixture):

```json
{
  "rounds": 3,
  "defaults": { "cap": 10000, "observationMs": 12000 },
  "scenarios": [
    { "name": "commented-pr", "itemId": "<PR ID>" },
    { "name": "commented-issue", "itemId": "<issue ID>" }
  ]
}
```

The suite obtains a full-snapshot reference per scenario, alternates strategy
order, fails on browser errors and writes `latest-suite.json` with coverage counts
beside timing medians. Individual raw reports remain ignored. Corpus hashes and
build commit/diff hashes identify the inputs. Reuse scenario names to replace
previous local reports; archive selected evidence outside Git if needed.

Use uncapped replay for equal-data comparisons; repeat with a low cap to expose
history admission delays. Include a CI/update-heavy PR, a normal issue and an
empty conversation before adopting a policy. Warm repository-to-detail navigation,
missing/slow relays, and interaction latency while events arrive require separate
scenarios; these cold-entry results alone do not validate those paths. Keep the
repository gate fixed across strategy comparisons: releasing it on first comment
would otherwise couple the policy to the outcome being measured.

### Bounded UX journeys

The same build, fixture server, runner and suite also support two journeys with
independently authored expected states. With `BENCH_CORPUS` unset, the server
generates a small public-key fixture: twelve issues, twelve PRs, discussion,
a re-title, a PR revision, a cover note and a withdrawn status. No external
data or account is required. Production scheduling remains unchanged.

```sh
node benchmarks/direct-entry-browser-build.mjs
# Separate terminals, as for captured replay:
env -u BENCH_CORPUS node benchmarks/direct-entry-browser-server.mjs
pnpm exec vite preview --host 127.0.0.1 --port 4192 --strictPort --outDir perf-reports/direct-entry/dist
# Use an existing browser-session lease, then close it and owned servers afterward:
node benchmarks/direct-entry-browser-suite.mjs "$lease" benchmarks/direct-entry-journey-suite.json
```

The checked-in configuration runs one smoke sample per journey with the shared
production query strategy. For comparisons, copy the config to ignored
`perf-reports/`, increase `rounds`, and select the strategies being investigated.
The suite alternates strategy order. Rebuild each application revision with the
same harness; preserve the reports, build metadata and worker configuration.
Reports include browser version, unsigned-corpus fingerprint and the build's
harness hash. One sample validates the harness, not a performance conclusion.

- **Cold detail → list during loading → detail:** navigation is scheduled at
  `navigateAtMs` from document start, independently of comment/count readiness.
  Record the actual action time and state at departure; a busy main thread or
  unavailable nav can delay the action. Filter the PR list while loading, clear
  the filter, then observe convergence and return to detail. The early detail
  checkpoint is deliberately censored on departure: unfinished essentials are
  reported, not treated as a failed final state. Later checkpoints must converge.
- **Return with activity:** first require initial repository/detail convergence,
  leave for About, make withheld events available, then revisit PRs, Issues and
  detail in the same browser context. One PR closes and another reopens, keeping
  the open-PR count unchanged; a new issue also arrives. Exact membership must
  change correctly. This exercises warm in-memory reuse and catch-up queries,
  not a browser reload or proof of persistent-cache durability.

`phaseMs` is a bounded observation window, not a latency acceptance threshold or
proof of completeness. Each checkpoint compares exact identities, titles and
statuses against the fixture manifest, including zero open items if specified.
The benchmark bundle records React-effect snapshots of the state consumed by
the layout/detail pages and marks their unmounts. These are **committed state**
observations, not pixel presentation. Detail essentials compare title, status
and tip separately and together; cover-note identity is separate. Existing
body/cover/comment DOM milestones remain rendering-opportunity proxies.

List observations read actual DOM title text and status-icon labels, with
benchmark-only row IDs. Reports include first nonempty rows, newest-issue DOM
arrival, and additions/removals/relative-order changes among retained rows.
Deliberate filtering is excluded from the churn window. Churn counts are not
layout-shift or viewport-visibility measurements. Repository open membership is
derived from the committed model state; the existing positive badge probe stays
separate and does not establish zero-versus-loading UI semantics.

Each outcome records first match, the final uninterrupted matching period within
the window, final state and explicit incompleteness. Suite summaries retain
individual timings and completion counts beside medians. Incorrect final
checkpoints or browser errors fail the suite while retaining raw reports and
the summary. Filtering durations include automation, DOM updates and two
animation frames; they are not INP. Per-phase requests, active subscriptions and
long tasks provide supporting diagnostics, not a resource-leak proof.

Captured corpora still work for existing experiments. To run these journeys on
one, supply a `journey` manifest matching `direct-entry-fixture.mjs`: selected
`itemId`, withheld `updateIds`, `newestId`, and explicit `initial`/`updated`
repository and detail expectations. The ordinary receipt-coverage fields in a
journey cover the initial selected events; the updated checkpoints validate
subsequent state separately. Do not derive all expectations from the same
production model under measurement.

These bounded journeys still mirror data across relays, stub Git HTTP and run
signed out. They do not validate real diff readiness, outbox/private behaviour,
partial relay overlap, long sessions or live updates after the return has
settled. Use targeted checks when a change threatens those paths rather than
interpreting these results as comprehensive coverage.

### Compare application revisions

`direct-entry-revision-suite.mjs` runs the same scenarios against two separately
built application revisions, alternating order and preserving failed runs. Use
the same current `direct-entry-*` harness files in both checkouts and keep each
preview server on its own port. Dependency versions must match, or dependency
changes must be treated explicitly as part of the comparison.

Provide the ordinary `defaults`, `scenarios` and `rounds` fields, replacing
`strategies` with:

```json
{
  "variants": [
    {
      "name": "older",
      "port": 4193,
      "metadataPath": "/absolute/older/checkout/perf-reports/direct-entry/build-meta.json"
    },
    {
      "name": "current",
      "port": 4192,
      "metadataPath": "perf-reports/direct-entry/build-meta.json"
    }
  ]
}
```

Run `node benchmarks/direct-entry-revision-suite.mjs "$lease" /path/to/suite.json`.
The runner checks matching instrumentation hashes, selects the appropriate
build metadata for each report, and restores the fixture server's original
metadata afterward. Run only one suite against that server at a time. Results
and individual failures remain in ignored `perf-reports/direct-entry/`; the
latest comparison is `latest-revision-suite.json`. Use explicit journey
expectations for correctness, and check received identity sets and unfinished
work before interpreting resource totals as equivalent workloads.

`negotiation-admission-suite.json` provides a bounded NIP-77 scheduling
comparison: two alternating pairs each for a seeded-cache conversation reload,
navigation during loading, and a return with new activity. The JSON is scenario
configuration, not a self-contained benchmark: it uses the existing revision
runner, instrumented production builds, a browser-session lease, and the fixture
server on 4190 loaded with the captured corpus via `BENCH_CORPUS`. The corpus
and raw reports are not committed. Serve the before/after
bundles on 4193/4192 and preserve their build metadata as
`perf-reports/direct-entry/before-meta.json` and `after-meta.json`. Run it with
the revision runner above. The selected conversation ID belongs to the captured
gitworkshop corpus; replace it when using another corpus with journey expectations.
The reload seeds event bodies, not relay membership or a warm EventStore.
Check remaining repository comments as well as selected-item readiness: the
20-second observation can end with unfinished history. A failed initial return
checkpoint is an incomplete run, not evidence of a successful warm comparison.

Under heavy replay, browser automation can itself queue behind WebSocket
delivery. In the cold journey, `scheduledAt` is the intended departure time,
`actualAt` is a pre-action observation, and `start` is sampled before the click
command. None measures the actual DOM click dispatch. Inspect these gaps and
phase boundaries before interpreting a navigation timeout as an equivalent
length UI freeze or a zero-offset list convergence as instant navigation.
Pair navigation runs with uninterrupted detail observations when necessary;
recorded long tasks and exact final membership provide separate evidence.

For an unresolved status observation, opt into `"storeDiagnostics": true`.
Reports then include retained EventStore IDs, insertion timestamps, and
`modelEmissions` from the active issue/PR hooks before React commits the page.
Hook rows precede the page's accepted-repository filter; compare matching
repository scopes. Receipt, store retention, model output and committed page
state are separate checkpoints. Deleted, expired and replaced events can be
received without remaining in the store.

On uninterrupted detail runs, `"followUpMs": 15000` adds a later checkpoint in
`report.followUp` without replacing the original cutoff or its incomplete
outcome. Use `report.requests` for original-window requests: the top-level
transport request count and pending count cover the whole run, including the
follow-up. Diagnostic allocations add overhead, so leave these options off for
ordinary performance comparisons. A later recovery establishes delay, not that
the original user-facing latency was acceptable.

### Diagnosing negotiated transfers

`transfer-diagnostics-suite.json` compares six alternating cold-navigation pairs,
two pairs each for reload/return, and capped reloads with healthy, slow, trickling
and stalled body sources. Use the captured corpus and revision runner described
above. These are diagnostic comparisons, not a new performance gate.

To isolate coordination while retaining unrelated current changes, build the
control with `BENCH_TRANSFER_CONTROL_REF=607f3668 node
benchmarks/direct-entry-browser-build.mjs`; this substitutes **only**
`src/lib/reconciledHistory.ts` from that revision. Build the candidate without
that variable. Preserve the two bundles separately, serve control/candidate on
4193/4192, and copy their metadata to `diagnostic-before-meta.json` and
`diagnostic-after-meta.json` in `perf-reports/direct-entry/`. Metadata records
the resolved override commit, path and source hash; this control is not the
complete historical application. Source instrumentation fails if its targets
change. Neither the override nor tracing affects release builds.

`stageDiagnostics` records history-path choices and matching inventory size,
negotiation enqueue/start/completion, admission
reservations/refusals, shared download demand/batches/delivery, and WebSocket
send/receive timestamps. Join these with existing store/model/UI observations.
The trace stops retaining rows at 100,000 and reports `traceDropped`; truncated
traces cannot establish absence of activity. Admission records include refused
reservations, so do not count every proposed wait as time actually spent queued.

`diagnosticCheckpointsMs` records exact wire IDs, missing expected IDs, model
state, comment marks, bytes and responsiveness at common elapsed deadlines.
Each checkpoint includes its actual sampling time: a busy event loop can delay
sampling. Return journeys release held updates as their phases advance, so
compare phase-relative correctness there rather than assuming equal elapsed
time means identical available data. Wire coverage is not cache or rendered
membership. Failed journeys
retain diagnostic state, and later completion does not erase an earlier deficit.

`transferFault` names one exact relay URL and a mode: `slow` adds two seconds,
`trickle` sends ten bodies per second, and `stall` sends no response. It affects
exact-ID requests containing no issue/PR roots; ordinary filters, root discovery
and negotiations stay healthy. Requests may originate outside reconciliation:
join fault subscription IDs with the trace and confirm negotiated demand before
attributing effects to the shared coordinator. Fault records prove application;
a zero-fault run is not evidence of resilience. Cancellation stops fixture
responses. These deliberately asymmetric, mirrored-corpus fixtures do not model
real relay availability, geographic latency, Git traffic or private relays.

Run `node benchmarks/transfer-diagnostics-summary.mjs <reports...>` to summarize
coverage, admission and body timing without dropping incomplete outcomes.
Summaries report the initial root REQ as `initial-snapshot` or `live-only`
(and mixed modes across relays), separately from later reconciliation choices.
A full ordinary snapshot can populate the inventory before NEG starts: a later
negotiation with hundreds of cached roots is not equivalent to one starting
with a single focused root. Compare like-for-like groups and also report their
frequencies; do not silently discard a path or infer causality from an aggregate
median when the groups do not overlap.

Negotiation wait estimates pair identical filters FIFO; cancelled overlapping
owners can leave unmatched enqueues, so inspect the raw trace before attributing
a delay. First ID request to first receipt also includes caps and retries; it is
not a pure network-latency measurement. Keep
raw reports and generated summaries under ignored `perf-reports/`; put conclusions
and representative evidence in the commit message. Diagnostic allocation and
trace serialization add overhead, so compare identically instrumented builds
and avoid treating these absolute timings as live production predictions.

### Repository cache storage comparison

With the captured-data direct-entry fixture server running on port 4190 and an
opened `browser-session` lease, run
`node benchmarks/repository-cache-browser.mjs "$lease"`. This manual benchmark
uses the installed nostr-idb backend in temporary databases: repository
essentials alone versus the same events in a shared cache of roughly 10,000
events, padded with synthetic unrelated collaboration events. It alternates
five reads per database with fresh application index/body maps, both idle and
with a competing 1,000-event write burst, and checks exact returned IDs against
independently selected fixture essentials. Results overwrite ignored
`perf-reports/cache/latest.json`; failures retain their browser log alongside it.

This measures storage query cost, not full reload paint time, OS-cold disk
reads, protected retention or migration correctness. Separate databases still
share browser and CPU resources. Use repeated comparisons before making a
storage architecture decision; do not interpret the synthetic filler as
verified relay events or the write burst as representative of every workload.
