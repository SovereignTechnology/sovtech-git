// Sequential, fresh-context comparisons. Raw reports remain outside Git.
// Usage: node benchmarks/direct-entry-browser-suite.mjs <lease> <suite.json>
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  const child = spawnSync(
    process.execPath,
    ["benchmarks/direct-entry-browser-run.mjs", lease],
    {
      stdio: "pipe",
      timeout:
        (config.followUpMs ?? 0) +
        (config.journey
          ? 6 * (config.phaseMs ?? 6000) + 90000
          : (config.observationMs ?? 12000) + 60000),
    },
  );
  const result = JSON.parse(
    readFileSync(`perf-reports/direct-entry/${config.label}.json`),
  );
  result.runFailed =
    child.status !== 0 ||
    !!result.report.failure ||
    !!result.report.journey?.failure ||
    result.errors.length > 0;
  console.log(
    config.label,
    JSON.stringify({
      marks: result.report.marks,
      coverage: Object.fromEntries(
        Object.entries(result.report.coverage ?? {}).map(([k, v]) => [
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
  if (common.journey) {
    for (let round = 0; round < (suite.rounds ?? 3); round++)
      for (const strategy of round % 2 ? [...strategies].reverse() : strategies)
        reports.push(
          run({
            ...common,
            strategy,
            fullSnapshotReference: false,
            label: `${scenario.name}-${strategy}-${round}`,
          }),
        );
    continue;
  }
  const reference = run({
    ...common,
    strategy: "shared",
    fullSnapshotReference: true,
    label: `${scenario.name}-reference`,
  });
  if (reference.runFailed) throw Error(`Invalid reference: ${scenario.name}`);
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
    if (scenario.journey ?? suite.defaults?.journey) {
      const phaseNames = [
        ...new Set(
          group.flatMap(
            (r) => r.report.journey?.phases.map((p) => p.name) ?? [],
          ),
        ),
      ];
      summary.push({
        scenario: scenario.name,
        strategy,
        runs: group.length,
        failedRuns: group.filter((r) => r.runFailed).length,
        phases: phaseNames.map((name) => {
          const samples = group.flatMap(
            (r) =>
              r.report.journey?.phases.filter((p) => p.name === name) ?? [],
          );
          return {
            name,
            samples: samples.length,
            outcomes: Object.fromEntries(
              ["repository", "openMembership", "detail", "cover", "list"].map(
                (key) => {
                  const applicable = samples.filter((s) => s[key]);
                  return [
                    key,
                    {
                      applicable: applicable.length,
                      complete: applicable.filter(
                        (s) => s[key].status === "complete",
                      ).length,
                      // Preserve individual timings and censored samples beside the median.
                      correctThroughEndMs: applicable.map(
                        (s) => s[key].correctThroughEndMs,
                      ),
                      medianMs: median(
                        applicable.map((s) => s[key].correctThroughEndMs),
                      ),
                    },
                  ];
                },
              ),
            ),
            churn: samples.map((s) => s.churn),
          };
        }),
        interactions: group.map((r) => ({
          label: r.config.label,
          actions: r.report.journey?.interactions ?? [],
        })),
      });
      continue;
    }
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
        group.map((r) => r.report.openPRCountReference?.correctThroughEndFrom),
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
if (reports.some((r) => r.runFailed)) process.exitCode = 1;
