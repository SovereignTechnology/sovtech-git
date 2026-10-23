// Sequential, fresh-context comparisons. Raw reports remain outside Git.
// Usage: node benchmarks/direct-entry-browser-suite.mjs <lease> <suite.json>
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [lease, file] = process.argv.slice(2);
if (!lease || !file)
  throw Error("Supply a browser-session lease and suite JSON");
const suite = JSON.parse(readFileSync(file));
const strategies = suite.strategies ?? [
  "shared",
  "thread-only",
  "one-shot",
  "immediate-root",
];
const reports = [];
function run(config) {
  if (!/^[a-zA-Z0-9_-]+$/.test(config.label ?? ""))
    throw Error("Invalid report label");
  writeFileSync(
    "perf-reports/direct-entry/config.json",
    JSON.stringify(config),
  );
  rmSync(`perf-reports/direct-entry/${config.label}.json`, { force: true });
  execFileSync(
    process.execPath,
    ["benchmarks/direct-entry-browser-run.mjs", lease],
    { stdio: "pipe", timeout: (config.observationMs ?? 12000) + 60000 },
  );
  const result = JSON.parse(
    readFileSync(`perf-reports/direct-entry/${config.label}.json`),
  );
  if (result.report.failure || result.errors.length)
    throw Error(`Invalid run: ${config.label}`);
  console.log(
    config.label,
    JSON.stringify({
      marks: result.report.marks,
      coverage: Object.fromEntries(
        Object.entries(result.report.coverage).map(([k, v]) => [
          k,
          { missing: v.missing.length, completeAt: v.completeAt },
        ]),
      ),
    }),
  );
  return result;
}
for (const scenario of suite.scenarios) {
  const common = {
    port: 4192,
    mode: "baseline",
    latencyMs: 20,
    ...suite.defaults,
    ...scenario,
  };
  const reference = run({
    ...common,
    strategy: "shared",
    fullSnapshotReference: true,
    label: `${scenario.name}-reference`,
  });
  const expectedOpenPRCount = reference.report.openPRCounts.at(-1)?.count;
  if (expectedOpenPRCount === undefined)
    throw Error("Full-snapshot PR badge missing");
  for (let round = 0; round < (suite.rounds ?? 3); round++) {
    for (const strategy of round % 2 ? [...strategies].reverse() : strategies) {
      reports.push(
        run({
          ...common,
          expectedOpenPRCount,
          fullSnapshotReference: false,
          strategy,
          label: `${scenario.name}-${strategy}-${round}`,
        }),
      );
    }
  }
}
const median = (xs) => {
  const values = xs
    .filter((x) => x !== null && x !== undefined)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
};
const summary = [];
for (const scenario of suite.scenarios)
  for (const strategy of strategies) {
    const group = reports.filter(
      (r) => r.config.name === scenario.name && r.config.strategy === strategy,
    );
    summary.push({
      scenario: scenario.name,
      strategy,
      runs: group.length,
      firstCommentOpportunity: median(
        group.map((r) => r.report.marks.firstCommentPaintOpportunity),
      ),
      allCommentOpportunity: median(
        group.map((r) => r.report.marks.allCommentsPaintOpportunity),
      ),
      // Null timings are censored; counts accompany medians so missing results cannot look fast.
      allCommentRuns: group.filter(
        (r) => r.report.marks.allCommentsPaintOpportunity !== undefined,
      ).length,
      repositoryCommentCompleteRuns: group.filter(
        (r) => r.report.coverage.repositoryComments.status === "complete",
      ).length,
      repositoryCommentComplete: median(
        group.map((r) => r.report.coverage.repositoryComments.completeAt),
      ),
      correctPRCount: median(
        group.map((r) => r.report.openPRCountReference.correctThroughEndFrom),
      ),
      correctPRCountRuns: group.filter(
        (r) => r.report.openPRCountReference.correctThroughEndFrom !== null,
      ).length,
      requests: median(group.map((r) => r.requestCount)),
      eventFrames: median(group.map((r) => r.report.eventFrames)),
      uniqueEvents: median(group.map((r) => r.report.unique)),
      longTaskTotal: median(
        group.map((r) => r.report.longTasks.reduce((sum, t) => sum + t.ms, 0)),
      ),
      longestTask: median(
        group.map((r) => Math.max(0, ...r.report.longTasks.map((t) => t.ms))),
      ),
    });
  }
writeFileSync(
  "perf-reports/direct-entry/latest-suite.json",
  JSON.stringify(
    { suite, summary, reports: reports.map((r) => r.config.label) },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary, null, 2));
