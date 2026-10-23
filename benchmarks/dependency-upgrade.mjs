// Run with Node --expose-gc. Each checkout must have its own frozen-lockfile install.
// Usage: node --expose-gc benchmarks/dependency-upgrade.mjs <v6-tree> <v7-tree> [store|transport|bundles]
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

const [baselinePath, candidatePath, mode = "store"] = process.argv.slice(2);
if (!baselinePath || !candidatePath)
  throw new Error("Pass installed v6 and v7 checkouts");
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
async function load(root) {
  root = resolve(root);
  assert.equal(
    git(root, "status", "--porcelain", "--untracked-files=no"),
    "",
    "Tracked benchmark inputs must be clean",
  );
  const require = createRequire(join(root, "package.json"));
  const core = await import(
    pathToFileURL(require.resolve("applesauce-core")).href
  );
  const helpers = await import(
    pathToFileURL(require.resolve("applesauce-core/helpers")).href
  );
  const relay = await import(
    pathToFileURL(require.resolve("applesauce-relay")).href
  );
  return {
    root,
    require,
    core,
    helpers,
    relay,
    metadata: {
      commit: git(root, "rev-parse", "HEAD"),
      tree: git(root, "rev-parse", "HEAD^{tree}"),
      lockSha256: createHash("sha256")
        .update(readFileSync(join(root, "pnpm-lock.yaml")))
        .digest("hex"),
      core: JSON.parse(
        readFileSync(join(root, "node_modules/applesauce-core/package.json")),
      ).version,
      relay: JSON.parse(
        readFileSync(join(root, "node_modules/applesauce-relay/package.json")),
      ).version,
      trackedClean: true,
    },
  };
}
const variants = {
  baseline: await load(baselinePath),
  candidate: await load(candidatePath),
};
const hex = (n) => n.toString(16).padStart(64, "0");
function corpus() {
  return Array.from({ length: 2000 }, (_, i) => ({
    id: hex(10000 + i),
    pubkey: hex(1),
    sig: "0".repeat(128),
    created_at: 1700000000 + i,
    kind: 1111,
    tags: [["E", hex(1 + (i % 500))]],
    content: "Fixed dependency comparison workload",
  }));
}
const scenarios = [
  "kind-only",
  "one-tag",
  "500-tags",
  "20-subscribers",
  "duplicate-delivery",
  "repeated-reads",
  "reads-one-tag",
  "reads-by-id",
  "cold-500-tag-read",
  "descending-history",
  "descending-500-tags",
  "replaceable-updates",
];
function measure(variant, scenario) {
  const events = corpus();
  if (scenario.startsWith("descending-")) events.reverse();
  if (scenario === "replaceable-updates")
    for (let i = 0; i < events.length; i++) {
      events[i].kind = 30617;
      events[i].tags = [["d", `repo-${i % 100}`]];
    }
  const tags = Array.from({ length: 500 }, (_, i) => hex(i + 1));
  const filters =
    scenario === "20-subscribers"
      ? Array.from({ length: 20 }, (_, i) => ({
          kinds: [1111],
          "#E": tags.slice(i * 25, i * 25 + 25),
        }))
      : [
          {
            kinds: [scenario === "replaceable-updates" ? 30617 : 1111],
            ...(["one-tag", "reads-one-tag"].includes(scenario)
              ? { "#E": [tags[0]] }
              : scenario === "reads-by-id"
                ? { ids: [events[0].id] }
                : [
                      "500-tags",
                      "descending-500-tags",
                      "cold-500-tag-read",
                      "repeated-reads",
                      "duplicate-delivery",
                    ].includes(scenario)
                  ? { "#E": tags }
                  : {}),
          },
        ];
  const store = new variant.core.EventStore();
  store.verifyEvent = variant.helpers.fakeVerifyEvent;
  const last = filters.map(() => []);
  let emissions = 0;
  const subscriptions =
    scenario === "cold-500-tag-read"
      ? []
      : filters.map((f, i) =>
          store.timeline(f).subscribe((items) => {
            last[i] = items;
            emissions++;
          }),
        );
  if (
    [
      "duplicate-delivery",
      "repeated-reads",
      "reads-one-tag",
      "reads-by-id",
      "cold-500-tag-read",
    ].includes(scenario)
  )
    for (const event of events) store.add(event);
  global.gc?.();
  const cpu = process.cpuUsage(),
    start = performance.now();
  let readCount = 0;
  if (scenario === "cold-500-tag-read") {
    last[0] = store.getByFilters(filters[0]);
    readCount = last[0].length;
  } else if (
    ["repeated-reads", "reads-one-tag", "reads-by-id"].includes(scenario)
  ) {
    for (let i = 0; i < 100; i++) {
      last[0] = store.getByFilters(filters[0]);
      readCount += last[0].length;
    }
  } else {
    const repetitions = scenario === "duplicate-delivery" ? 5 : 1;
    for (let n = 0; n < repetitions; n++)
      for (const event of events)
        store.add(
          scenario === "duplicate-delivery"
            ? { ...event, tags: event.tags.map((t) => [...t]) }
            : event,
        );
  }
  const elapsedMs = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  try {
    for (let i = 0; i < filters.length; i++) {
      const expected = events.filter(
        (e, index) =>
          (scenario !== "replaceable-updates" || index >= 1900) &&
          (!filters[i]["#E"] || filters[i]["#E"].includes(e.tags[0][1])) &&
          (!filters[i].ids || filters[i].ids.includes(e.id)),
      );
      assert.deepEqual(
        new Set(last[i].map((e) => e.id)),
        new Set(expected.map((e) => e.id)),
      );
    }
    if (scenario === "repeated-reads") assert.equal(readCount, 200000);
    if (scenario === "reads-one-tag") assert.equal(readCount, 400);
    if (scenario === "reads-by-id") assert.equal(readCount, 100);
    return {
      elapsedMs,
      cpuMs: (usage.user + usage.system) / 1000,
      emissions,
      resultCount: last.reduce((n, items) => n + items.length, 0),
      readCount,
    };
  } finally {
    for (const sub of subscriptions) sub.unsubscribe();
    store.dispose();
  }
}
function stats(values) {
  values.sort((a, b) => a - b);
  return {
    median:
      (values[Math.floor((values.length - 1) / 2)] +
        values[Math.floor(values.length / 2)]) /
      2,
    min: values[0],
    max: values.at(-1),
  };
}
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  mode,
  baseline: variants.baseline.metadata,
  candidate: variants.candidate.metadata,
};
if (mode === "store") {
  assert.ok(
    global.gc,
    "Use --expose-gc so between-sample GC policy is reproducible",
  );
  report.method = {
    events: 2000,
    pairs: 10,
    warmups: 2,
    order: "alternating AB/BA",
    verification: "disabled",
    gc: "before every timed sample",
    limitations:
      "Synthetic Node workload; excludes React, IndexedDB, relay transport and real signatures. CPU includes runtime overhead. Correct event identities checked outside timed region.",
  };
  report.samples = [];
  for (const scenario of scenarios) {
    for (let warm = 0; warm < 2; warm++)
      for (const variant of Object.values(variants)) measure(variant, scenario);
    for (let pair = 0; pair < 10; pair++)
      for (const variant of pair % 2
        ? ["candidate", "baseline"]
        : ["baseline", "candidate"])
        report.samples.push({
          scenario,
          pair,
          variant,
          ...measure(variants[variant], scenario),
        });
  }
  report.summary = Object.fromEntries(
    scenarios.map((scenario) => [
      scenario,
      Object.fromEntries(
        Object.keys(variants).map((variant) => {
          const samples = report.samples.filter(
            (s) => s.scenario === scenario && s.variant === variant,
          );
          return [
            variant,
            {
              elapsedMs: stats(samples.map((s) => s.elapsedMs)),
              cpuMs: stats(samples.map((s) => s.cpuMs)),
              resultCount: samples[0].resultCount,
              emissions: samples[0].emissions,
            },
          ];
        }),
      ),
    ]),
  );
} else if (mode === "transport") {
  // ws is already supplied by the installed jsdom dependency; no global packages.
  const jsdomRequire = createRequire(
    variants.candidate.require.resolve("jsdom"),
  );
  const { WebSocketServer } = jsdomRequire("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const timers = new Set();
  let plan;
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const [type, id] = JSON.parse(String(data));
      if (type !== "REQ") return;
      const current = plan;
      const schedule = (delay, frame) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (socket.readyState === 1) socket.send(JSON.stringify(frame));
        }, delay);
        timers.add(timer);
      };
      for (let i = 0; i < current.events; i++)
        schedule(10 + i * current.intervalMs, ["EVENT", id, corpus()[i]]);
      schedule(current.eoseMs, ["EOSE", id]);
    }),
  );
  report.samples = [];
  report.method =
    "Real local WebSocket, default request deadline, reconnect disabled. One execution per case/version; lifecycle check, not a statistical latency benchmark. Scheduled waits are the tested relay behavior. Authentication excluded.";
  try {
    for (const scenario of ["fast", "stream-past-30s"])
      for (const [variant, modules] of Object.entries(variants)) {
        plan =
          scenario === "fast"
            ? { events: 7, intervalMs: 10, eoseMs: 100 }
            : { events: 7, intervalMs: 5000, eoseMs: 35000 };
        const relay = new modules.relay.Relay(
          `ws://127.0.0.1:${server.address().port}`,
        );
        const start = performance.now();
        let count = 0,
          firstEventMs = null,
          subscription;
        const result = await new Promise((resolve) => {
          const guard = setTimeout(() => {
            subscription?.unsubscribe();
            resolve({ outcome: "guard-timeout" });
          }, 40000);
          const finish = (result) => {
            clearTimeout(guard);
            resolve(result);
          };
          subscription = relay
            .request({ kinds: [1111] }, { reconnect: false })
            .subscribe({
              next: () => {
                count++;
                firstEventMs ??= performance.now() - start;
              },
              error: (error) =>
                finish({
                  outcome: "error",
                  error: error.name,
                  message: error.message,
                }),
              complete: () => finish({ outcome: "complete" }),
            });
        });
        report.samples.push({
          scenario,
          variant,
          elapsedMs: performance.now() - start,
          firstEventMs,
          events: count,
          ...result,
        });
        subscription?.unsubscribe();
        relay.close();
        relay.dispose?.();
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
} else if (mode === "bundles") {
  report.method =
    "Production dist assets, individual gzip level 9 per JS/CSS file, excludes sourcemaps. Total includes lazy chunks; not initial transferred bytes.";
  report.bundles = {};
  for (const [variant, { root }] of Object.entries(variants)) {
    const assets = join(root, "dist/assets");
    const files = readdirSync(assets).filter((name) =>
      /\.(js|css)$/.test(name),
    );
    report.bundles[variant] = {
      files: files.length,
      rawBytes: files.reduce((n, f) => n + statSync(join(assets, f)).size, 0),
      gzipBytes: files.reduce(
        (n, f) =>
          n + gzipSync(readFileSync(join(assets, f)), { level: 9 }).length,
        0,
      ),
    };
  }
} else throw new Error(`Unknown mode: ${mode}`);
console.log(JSON.stringify(report, null, 2));
