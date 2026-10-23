// Compare reports only after checking that the browser, harness and data match.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function summarize(reports) {
  if (!reports.length) throw new Error("No samples");
  const first = reports[0];
  if (
    !first.fixtureSha256 ||
    reports.some((r) => !r.config.matchedData || r.config.live)
  )
    throw new Error("Missing controlled matched-data provenance");
  const ready = (r) =>
    r.milestones.find((m) => m.label === "matched-data-ready");
  const workload = (r) =>
    JSON.stringify({
      scenario: r.config.scenario,
      latencyMs: r.config.latencyMs ?? 20,
      observationMs: r.config.observationMs ?? 20000,
    });
  const eventHash = ready(first)?.metrics.eventIdsSha256;
  if (!eventHash) throw new Error("Missing matched-data readiness");
  for (const r of reports) {
    if (r.failure || r.errors.length || r.networkFailures.length)
      throw new Error(`Failed replay: ${r.config.name}`);
    if (
      workload(r) !== workload(first) ||
      r.browser !== first.browser ||
      r.fixtureSha256 !== first.fixtureSha256 ||
      ready(r)?.metrics.eventIdsSha256 !== eventHash
    )
      throw new Error("Browser or received data differs across samples");
    const final = r.milestones.find((m) => m.label === "cold-observation");
    if (final?.metrics.eventIdsSha256 !== eventHash)
      throw new Error(
        "Events continued arriving during the settled interaction",
      );
  }
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted.at(-1),
      samples: values,
    };
  };
  return {
    browser: first.browser,
    workload: workload(first),
    fixtureSha256: first.fixtureSha256,
    eventIdsSha256: eventHash,
    events: ready(first).metrics.unique,
    samples: reports.length,
    filterMs: stats(
      reports.map(
        (r) =>
          r.milestones.find((m) => m.label === "filter-after-matched-data")
            .interactionMs,
      ),
    ),
    firstContentMs: stats(reports.map((r) => r.readyMs)),
    startupLongTaskMs: stats(
      reports.map((r) =>
        ready(r).metrics.longTasks.reduce((n, t) => n + t.ms, 0),
      ),
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [beforePath, afterPath, output] = process.argv.slice(2);
  if (!beforePath || !afterPath)
    throw new Error(
      "Usage: node benchmarks/replay-report.mjs before.json after.json [output.json]",
    );
  const before = JSON.parse(readFileSync(beforePath));
  const after = JSON.parse(readFileSync(afterPath));
  for (const key of ["browser", "fixtureSha256", "eventIdsSha256", "workload"])
    if (before.summary[key] !== after.summary[key])
      throw new Error(`Cannot compare: ${key} differs`);
  if (!before.harnessSha256 || before.harnessSha256 !== after.harnessSha256)
    throw new Error("Harness differs");
  if (before.resources !== after.resources)
    throw new Error("Worker resources differ");
  const comparison = {
    before,
    after,
    interpretation:
      "Settled equal-data desktop replay. Filter duration includes automation and two animation frames; not INP or physical presentation. Live relay and mobile performance are not measured.",
  };
  const json = JSON.stringify(comparison, null, 2);
  if (output) writeFileSync(output, json);
  console.log(json);
}
