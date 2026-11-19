// Manual storage microbenchmark. Requires the captured-data direct-entry fixture
// server on :4190 and a browser-session lease. Does not touch the app database.
// Usage: node benchmarks/repository-cache-browser.mjs <lease>
import { build } from "vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

async function runCacheComparison(page, bundle) {
  const fixture = await (
    await page.request.get("http://127.0.0.1:4190/fixture")
  ).json();
  const context = await page.context().browser().newContext();
  const probe = await context.newPage();
  try {
    await probe.goto("http://127.0.0.1:4190/");
    await probe.evaluate((encoded) => {
      const script = document.createElement("script");
      script.textContent = atob(encoded);
      document.head.appendChild(script);
    }, bundle);
    const report = await probe.evaluate(async ({ events, coordinate }) => {
      const { openDB, deleteDB, addEvents, NostrIDB } = window.cacheBench;
      const roots = events.filter(
        (e) =>
          [1621, 1617, 1618].includes(e.kind) &&
          e.tags.some((t) => t[0] === "a" && t[1] === coordinate),
      );
      const rootIds = new Set(roots.map((e) => e.id));
      const children = events.filter((e) =>
        e.tags.some(
          (t) =>
            (([1630, 1631, 1632, 1633, 1985, 1624, 5].includes(e.kind) &&
              t[0] === "e") ||
              (e.kind === 1619 && t[0] === "E")) &&
            rootIds.has(t[1]),
        ),
      );
      const childIds = new Set(children.map((e) => e.id));
      const withdrawals = events.filter(
        (e) =>
          e.kind === 5 &&
          e.tags.some((t) => t[0] === "e" && childIds.has(t[1])),
      );
      const essentials = [
        ...new Map(
          [...roots, ...children, ...withdrawals].map((e) => [e.id, e]),
        ).values(),
      ];
      const expected = essentials
        .map((e) => e.id)
        .sort()
        .join(",");
      const hex = (n) => n.toString(16).padStart(64, "0");
      if (events.length > 10000)
        throw Error("Fixture exceeds shared cache size");
      const filler = Array.from({ length: 10000 - events.length }, (_, i) => {
        const e = events[i % events.length];
        return {
          ...e,
          id: hex(i + 1000000),
          pubkey: hex(i + 2000000),
          tags: e.tags.map((t) => {
            if (t[0] === "a")
              return [
                t[0],
                "30617:" + hex(i + 2000000) + ":other",
                ...t.slice(2),
              ];
            if (["e", "E", "q"].includes(t[0]))
              return [t[0], hex(i + 3000000), ...t.slice(2)];
            return t;
          }),
        };
      });
      const prefix = "gw-cache-bench-" + crypto.randomUUID();
      const names = {
        small: prefix + "-small",
        shared: prefix + "-shared",
        noise: prefix + "-noise",
      };
      const dbs = {};
      const rows = [];
      try {
        for (const [key, name] of Object.entries(names))
          dbs[key] = await openDB(name);
        await addEvents(dbs.small, essentials);
        await addEvents(dbs.shared, [...events, ...filler]);
        await addEvents(dbs.noise, filler);
        const stored = {};
        for (const key of Object.keys(dbs))
          stored[key] = await dbs[key].count("events");
        for (const contention of [false, true]) {
          for (let round = 0; round < 5; round++) {
            for (const key of round % 2
              ? ["shared", "small"]
              : ["small", "shared"]) {
              const client = new NostrIDB(dbs[key]);
              const timings = [];
              const read = async (filters) => {
                const at = performance.now();
                const query =
                  typeof client.query === "function"
                    ? client.query
                    : client.filters;
                const out = await query.call(client, filters);
                timings.push({ ms: performance.now() - at, count: out.length });
                return out;
              };
              const start = performance.now();
              const writeDb = dbs[key === "shared" ? "shared" : "noise"];
              const writing = contention
                ? addEvents(writeDb, filler.slice(0, 1000)).then(() =>
                    writeDb.count("events"),
                  )
                : Promise.resolve();
              const r = await read([
                { kinds: [1621, 1617, 1618], "#a": [coordinate] },
              ]);
              const ids = r.map((e) => e.id);
              const c = await read([
                { kinds: [1630, 1631, 1632, 1633, 1985, 1624, 5], "#e": ids },
                { kinds: [1619], "#E": ids },
              ]);
              const w = c.length
                ? await read([{ kinds: [5], "#e": c.map((e) => e.id) }])
                : [];
              const ms = performance.now() - start;
              const actual = [...new Set([...r, ...c, ...w].map((e) => e.id))]
                .sort()
                .join(",");
              if (actual !== expected)
                throw Error("Membership mismatch: " + key + " round " + round);
              await writing;
              rows.push({ key, round, contention, ms, timings });
            }
          }
        }
        return {
          stored,
          rootCount: roots.length,
          essentialCount: essentials.length,
          rows,
        };
      } finally {
        for (const db of Object.values(dbs)) db.close();
        for (const name of Object.values(names)) await deleteDB(name);
      }
    }, fixture);
    return {
      ...report,
      corpusHash: fixture.corpusHash,
      capturedAt: fixture.capturedAt,
    };
  } finally {
    await context.close();
  }
}

const require = createRequire(import.meta.url);
const entry = resolve(
  dirname(require.resolve("window.nostrdb.js")),
  "../../nostr-idb/dist/index.js",
);
const built = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: true,
    lib: { entry, name: "cacheBench", formats: ["iife"] },
  },
});
const bundle = (Array.isArray(built) ? built[0] : built).output.find(
  (item) => item.type === "chunk",
).code;
const result = spawnSync(
  "browser-session",
  [
    "playwright",
    process.argv[2],
    "run-code",
    `async(page) => { return (${runCacheComparison.toString()})(page, ${JSON.stringify(Buffer.from(bundle).toString("base64"))}); }`,
  ],
  { encoding: "utf8", maxBuffer: 1e7 },
);
mkdirSync("perf-reports/cache", { recursive: true });
writeFileSync(
  "perf-reports/cache/latest-browser.log",
  result.stdout + "\n" + result.stderr,
);
const section = result.stdout.split("### Result\n")[1]?.split("\n###")[0];
if (result.status !== 0 || !section)
  throw Error(
    "Storage benchmark failed; see perf-reports/cache/latest-browser.log",
  );
const report = JSON.parse(section);
report.generatedAt = new Date().toISOString();
report.limitations = [
  "Captured gitworkshop corpus; unrelated cache pressure uses structurally valid synthetic events with invalid signatures.",
  "Five alternating rounds with fresh application index/body maps, not cold operating-system disk caches.",
  "Write contention is one 1,000-event burst; browser/CPU contention also affects isolated databases.",
  "Tests backend query cost and exact membership, not full application startup, cache eviction, migration or relay freshness.",
];
writeFileSync(
  "perf-reports/cache/latest.json",
  JSON.stringify(report, null, 2) + "\n",
);
for (const contention of [false, true]) {
  for (const key of ["small", "shared"]) {
    const samples = report.rows
      .filter((row) => row.key === key && row.contention === contention)
      .map((row) => row.ms)
      .sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        key,
        contention,
        medianMs: samples[Math.floor(samples.length / 2)],
        minMs: samples[0],
        maxMs: samples.at(-1),
      }),
    );
  }
}
