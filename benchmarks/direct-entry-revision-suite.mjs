// Compare separately built application revisions with one running fixture server.
// Usage: node benchmarks/direct-entry-revision-suite.mjs <lease> <suite.json>
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [lease, file] = process.argv.slice(2);
if (!lease || !file)
  throw Error("Supply a browser-session lease and suite JSON");
const suite = JSON.parse(readFileSync(file));
const directory = "perf-reports/direct-entry/";
const metadataPath = directory + "build-meta.json";
const originalMetadata = readFileSync(metadataPath);
const variants = suite.variants.map((variant) => ({
  ...variant,
  metadata: readFileSync(variant.metadataPath),
}));
if (new Set(variants.map((v) => JSON.parse(v.metadata).harnessHash)).size !== 1)
  throw Error("Revisions must use identical benchmark instrumentation");
const results = [];
let corpusHash;
try {
  for (const scenario of suite.scenarios) {
    for (
      let round = 0;
      round < (scenario.rounds ?? suite.rounds ?? 3);
      round++
    ) {
      for (const variant of round % 2 ? [...variants].reverse() : variants) {
        const label = `${scenario.name}-${variant.name}-${round}`;
        if (!/^[a-zA-Z0-9_-]+$/.test(label))
          throw Error("Invalid report label");
        const config = {
          mode: "baseline",
          strategy: "shared",
          ...suite.defaults,
          ...scenario,
          port: variant.port,
          label,
          fullSnapshotReference: false,
        };
        writeFileSync(metadataPath, variant.metadata);
        writeFileSync(directory + "config.json", JSON.stringify(config));
        rmSync(directory + label + ".json", { force: true });
        const child = spawnSync(
          process.execPath,
          ["benchmarks/direct-entry-browser-run.mjs", lease],
          {
            encoding: "utf8",
            timeout:
              6 * (config.phaseMs ?? 12000) + 90000 + (config.followUpMs ?? 0),
          },
        );
        let row;
        try {
          const report = JSON.parse(readFileSync(directory + label + ".json"));
          corpusHash ??= report.corpusHash;
          const failure =
            report.report.failure ||
            report.report.journey?.failure ||
            (child.status !== 0
              ? `Runner failed: ${child.error ?? child.signal ?? child.status}`
              : null) ||
            (report.errors.length ? "Browser errors (see report)" : null) ||
            (report.corpusHash !== corpusHash
              ? "Corpus changed between runs"
              : null) ||
            (report.config.label !== label ? "Report label mismatch" : null) ||
            (JSON.stringify(report.build) !==
            JSON.stringify(JSON.parse(variant.metadata))
              ? "Build revision mismatch"
              : null);
          row = {
            label,
            revision: report.build.commit,
            corpusHash: report.corpusHash,
            failed: !!failure,
            failure,
            errors: report.errors,
            journey: report.report.journey,
            uniqueEvents: report.report.unique,
            requests: report.requestCount,
            longTaskMs: report.report.longTasks?.reduce(
              (sum, t) => sum + t.ms,
              0,
            ),
          };
        } catch (error) {
          row = {
            label,
            failed: true,
            failure: String(error),
            stderr: child.stderr,
            stdout: child.stdout,
          };
        }
        results.push(row);
        writeFileSync(
          directory + "latest-revision-suite.json",
          JSON.stringify({ suite, results }, null, 2),
        );
        console.log(
          label,
          JSON.stringify({
            failed: row.failed,
            failure: row.failure,
            requests: row.requests,
            longTaskMs: row.longTaskMs,
          }),
        );
      }
    }
  }
} finally {
  writeFileSync(metadataPath, originalMetadata);
}
if (results.some((r) => r.failed)) process.exitCode = 1;
