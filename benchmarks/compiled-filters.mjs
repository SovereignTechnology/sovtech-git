// Isolate live timeline matching from stored queries, rendering and relay latency.
// BENCH_CORPUS=/path/capture.json.gz node benchmarks/compiled-filters.mjs <before-filter.js> <after-filter.js>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const roots = process.argv.slice(2);
if (roots.length !== 2 || !process.env.BENCH_CORPUS)
  throw Error("Supply two Applesauce filter module paths and BENCH_CORPUS");
const data = readFileSync(process.env.BENCH_CORPUS);
const corpus = JSON.parse(gunzipSync(data));
const ids = corpus.events
  .filter((event) => [1617, 1618, 1621].includes(event.kind))
  .map((event) => event.id);
assert(ids.length > 20, "Capture must contain a broad repository root set");
const variants = await Promise.all(
  roots.map(async (file, index) => {
    const modulePath = resolve(file);
    return {
      name: index ? "after" : "before",
      modulePath,
      sourceHash: createHash("sha256")
        .update(readFileSync(modulePath))
        .digest("hex"),
      methods: await import(pathToFileURL(modulePath)),
    };
  }),
);
assert.notEqual(
  variants[0].sourceHash,
  variants[1].sourceHash,
  "Both inputs resolve to identical matcher implementations; check shared node_modules",
);
const rows = [];
for (let round = 0; round < 9; round++) {
  for (const variant of round % 2 ? [...variants].reverse() : variants) {
    for (const width of [1, 20, ids.length]) {
      const filter = { kinds: [1111], "#E": ids.slice(0, width) };
      const start = performance.now();
      const matches = variant.methods.compileFilter(filter);
      const compileMs = performance.now() - start;
      const expected = corpus.events
        .filter((event) => variants[0].methods.matchFilter(filter, event))
        .map((event) => event.id)
        .sort();
      assert.deepEqual(
        corpus.events
          .filter(matches)
          .map((event) => event.id)
          .sort(),
        expected,
      );
      const matchingStart = performance.now();
      let count = 0;
      for (let pass = 0; pass < 50; pass++)
        for (const event of corpus.events) count += Number(matches(event));
      assert.equal(count, expected.length * 50);
      rows.push({
        variant: variant.name,
        round,
        width,
        compileMs,
        matchingMs: performance.now() - matchingStart,
        eventChecks: 50 * corpus.events.length,
        matchingIdsHash: createHash("sha256")
          .update(JSON.stringify(expected))
          .digest("hex"),
      });
    }
  }
}
const median = (values) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = variants.flatMap(({ name }) =>
  [1, 20, ids.length].map((width) => {
    const group = rows.filter(
      (row) => row.variant === name && row.width === width,
    );
    return {
      variant: name,
      width,
      matchingMs: median(group.map((row) => row.matchingMs)),
      compileMs: median(group.map((row) => row.compileMs)),
    };
  }),
);
mkdirSync("perf-reports", { recursive: true });
writeFileSync(
  process.env.BENCH_REPORT ?? "perf-reports/compiled-filters.json",
  JSON.stringify(
    {
      corpusHash: createHash("sha256").update(data).digest("hex"),
      events: corpus.events.length,
      limitations:
        "Nine alternating-order rounds, 50 corpus passes per filter. Synthetic repetition measures matcher throughput, not user latency, CPU responsiveness, fetching completeness or rendering. Matchers and event tag caches are warmed by correctness checks before timing. Compilation is recorded separately; no memory-retention claim.",
      variants: variants.map(({ methods: _methods, ...metadata }) => metadata),
      rows,
      summary,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary, null, 2));
