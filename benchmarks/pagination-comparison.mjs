// Controlled loader comparison. No production relay traffic or browser claims.
// Usage: node benchmarks/pagination-comparison.mjs <compat-tree> <auto-tree> <current-tree>
// Dependencies are resolved from this checkout; all three trees must use the same v7 lockfile.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { BehaviorSubject, Observable } from "rxjs";
import { EventStore } from "applesauce-core";
import { fakeVerifyEvent } from "applesauce-core/helpers";
import { compileFilter } from "applesauce-core/helpers/filter";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const roots = process.argv.slice(2).map((root) => resolve(root));
if (roots.length !== 3)
  throw new Error(
    "Supply compatibility, automatic, and current checkout paths",
  );
const out = resolve("perf-reports/pagination-performance");
mkdirSync(out, { recursive: true });
const modules = [];
for (const [i, root] of roots.entries()) {
  const outfile = join(out, `loaders-${i}.mjs`);
  await build({
    stdin: {
      contents: `export * from ${JSON.stringify(join(root, "src/lib/resilientSubscription.ts"))}; export * from ${JSON.stringify(join(root, "src/lib/manualTimelineLoader.ts"))}; export * from ${JSON.stringify(join(root, "src/lib/tagValuePaginatedLoader.ts"))};`,
      resolveDir: root,
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    alias: { "@": join(root, "src") },
    define: { "import.meta.env": "{}" },
  });
  const sourcePatch = execFileSync("git", ["diff", "HEAD", "--", "src/lib"], {
    cwd: root,
    encoding: "utf8",
  });
  modules.push({
    sourcePatch,
    sourcePatchSha256: sourcePatch
      ? createHash("sha256").update(sourcePatch).digest("hex")
      : null,
    api: await import(pathToFileURL(outfile)),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    root,
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const base = Math.floor(Date.now() / 1000) - 10000;
function event(i, kind = 1111) {
  return {
    id: i.toString(16).padStart(64, "0"),
    pubkey: "1".repeat(64),
    kind,
    created_at: base - i,
    tags: [["E", "2".repeat(64)]],
    content: "controlled history payload ".repeat(20),
    sig: "0".repeat(128),
  };
}
const corpus = Array.from({ length: 2000 }, (_, i) => event(i + 1));
async function run(version, scenario, repeat) {
  const { api } = version;
  const notificationScenario = scenario.startsWith("notifications");
  const latency = scenario.endsWith("-slow") ? 1000 : 20;
  const metrics = {
    requests: 0,
    filterBytes: 0,
    eventFrames: 0,
    eventBytes: 0,
    active: 0,
    maxActive: 0,
    unique: new Set(),
    firstEventMs: null,
    usefulEventMilestones: [],
    storeInsertMs: 0,
    emissions: 0,
  };
  const store = new EventStore();
  store.verifyEvent = fakeVerifyEvent;
  const model = store
    .timeline({ kinds: [1111, 1621, 9735] })
    .subscribe(() => metrics.emissions++);
  const started = performance.now(),
    cpu = process.cpuUsage();
  const insert = (e) => {
    if (e === "EOSE") return;
    metrics.firstEventMs ??= performance.now() - started;
    metrics.unique.add(e.id);
    const t = performance.now();
    store.add(e);
    metrics.storeInsertMs += performance.now() - t;
  };
  let serial = 0;
  const urls = [`wss://controlled-${repeat}-${scenario}-${serial++}.test`];
  if (notificationScenario) urls.push(`wss://controlled-sparse-${repeat}.test`);
  const data = notificationScenario
    ? Array.from({ length: 1800 }, (_, i) =>
        event(i + 1, [1111, 1621, 9735][i % 3]),
      )
    : corpus;
  const cap =
    scenario === "equal-data" ? 2000 : scenario === "tag-history" ? 100 : 200;
  const pool = {
    relay(url) {
      return {
        error$: new BehaviorSubject(null),
        request(filters) {
          return response(url, filters, false);
        },
        subscription(filters) {
          return response(url, filters, true);
        },
      };
    },
  };
  function response(url, filters, live) {
    return new Observable((s) => {
      metrics.requests++;
      metrics.filterBytes += Buffer.byteLength(JSON.stringify(filters));
      metrics.active++;
      metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
      let finished = false;
      const t = setTimeout(() => {
        const available =
          notificationScenario && url.includes("sparse")
            ? data.filter((_, i) => i % 20 === 0)
            : data;
        const found = new Map();
        for (const f of filters) {
          const match = compileFilter(f);
          for (const e of available
            .filter(match)
            .slice(0, Math.min(f.limit ?? cap, cap)))
            found.set(e.id, e);
        }
        for (const e of found.values()) {
          metrics.eventFrames++;
          metrics.eventBytes += Buffer.byteLength(JSON.stringify(e));
          s.next(e);
        }
        finished = true;
        metrics.active--;
        if (live) s.next("EOSE");
        else s.complete();
      }, latency);
      return () => {
        clearTimeout(t);
        if (!finished) metrics.active--;
      };
    });
  }
  const outcomes = [];
  let sub, loader;
  if (notificationScenario) {
    loader = api.createManualTimelineLoader(
      pool,
      urls,
      [{ kinds: [1111] }, { kinds: [1621] }, { kinds: [9735] }],
      { eventStore: store, getArchiveCutoff: () => base - 900 },
    );
    // Measure actual additions without substituting a fake store.
    const storeSub = store.insert$.subscribe((inserted) => {
      metrics.unique.add(inserted.id);
      if ([200, 600, 1200, 1794].includes(metrics.unique.size))
        metrics.usefulEventMilestones.push({
          unique: metrics.unique.size,
          ms: performance.now() - started,
        });
      metrics.firstEventMs ??= performance.now() - started;
    });
    for (let page = 0; page < 3; page++) {
      const t = performance.now();
      loader.loadMore(200);
      while (loader.historyLoading$.value && performance.now() - t < 10000)
        await pause(10);
      outcomes.push({
        page: page + 1,
        ms: performance.now() - t,
        unique: metrics.unique.size,
        requests: metrics.requests,
        loading: loader.historyLoading$.value,
        hasMore: loader.historyHasMore$.value,
        archive: loader.historyReachedArchive$.value,
      });
      if (loader.historyLoading$.value) break;
    }
    loader.destroy();
    storeSub.unsubscribe();
  } else {
    if (scenario === "tag-history") {
      const load = api.createPaginatedTagValueLoader(pool, "E", {
        limit: 500,
        bufferSize: 1,
        bufferTime: 1000,
        onHistoryStatus: (s) =>
          outcomes.push({ state: s.state, reason: s.reason }),
      });
      sub = load({ value: "2".repeat(64), relays: urls }).subscribe(insert);
    } else
      sub = api
        .resilientRequest(
          pool,
          urls,
          [{ kinds: [1111], limit: scenario === "equal-data" ? 2500 : 500 }],
          {
            paginate: true,
            limit: scenario === "equal-data" ? 2500 : 500,
            settleTime: 1,
            onHistoryStatus: (s) =>
              outcomes.push({ state: s.state, reason: s.reason }),
          },
        )
        .subscribe(insert);
    // Fixed observation horizon is the measurement, not a readiness assertion.
    await pause(scenario === "equal-data" ? 3500 : 12500);
    sub.unsubscribe();
  }
  const elapsedMs = performance.now() - started,
    used = process.cpuUsage(cpu);
  model.unsubscribe();
  store.dispose();
  const result = {
    scenario,
    latencyMs: latency,
    repeat,
    commit: version.commit,
    sourcePatchSha256: version.sourcePatchSha256,
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    ...metrics,
    storeInsertMs: notificationScenario ? null : metrics.storeInsertMs,
    unique: metrics.unique.size,
    expected: data.length,
    coverage: metrics.unique.size / data.length,
    outcomes,
  };
  console.log(JSON.stringify(result));
  return result;
}
const results = [];
// Alternating order prevents warm-up always favouring the same revision.
for (let repeat = 0; repeat < 3; repeat++)
  for (const scenario of (
    process.env.PAGINATION_SCENARIOS ??
    "automatic-history,tag-history,notifications"
  ).split(","))
    for (const version of repeat % 2 ? [...modules].reverse() : modules) {
      results.push(await run(version, scenario, repeat));
      writeFileSync(
        join(out, process.env.PAGINATION_REPORT ?? "controlled.json"),
        JSON.stringify(
          {
            metadata: {
              node: process.version,
              created: new Date().toISOString(),
              latencyByScenarioMs: { default: 20, "notifications-slow": 1000 },
              automaticObservationMs: 12500,
              equalDataObservationMs: 3500,
              versions: modules.map(
                ({ root, commit, sourcePatch, sourcePatchSha256 }) => ({
                  root,
                  commit,
                  sourcePatch,
                  sourcePatchSha256,
                }),
              ),
              note: "Real timers and pacing; CPU is this Node process, not browser CPU. Counts are a fixed synthetic corpus, not Nostr-wide completeness.",
            },
            results,
          },
          null,
          2,
        ),
      );
    }
process.exit(0);
