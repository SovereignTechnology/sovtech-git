// Run against the signed fixture server started with BENCH_OUTBOX=1 and a
// benchmark preview on 4192. Usage: node benchmarks/direct-entry-curation-suite.mjs <lease>
// Raw observations stay in ignored perf-reports; each run owns a fresh context.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const lease = process.argv[2];
if (!lease) throw Error("Supply a browser-session lease");
for (const [name, warm, nip77, width, height] of [
  ["warm", true, true, 1440, 900],
  ["cold", false, true, 768, 1024],
  ["fallback", true, false, 390, 844],
]) {
  const label = `curation-${name}`;
  writeFileSync(
    "perf-reports/direct-entry/config.json",
    JSON.stringify({
      label,
      port: 4192,
      mode: "baseline",
      strategy: "shared",
      cap: 10000,
      latencyMs: 20,
      commentLatencyMs: 20,
      observationMs: 8000,
      curation: true,
      fullSnapshotReference: warm,
      nip77,
      viewport: { width, height },
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["benchmarks/direct-entry-browser-run.mjs", lease],
    { encoding: "utf8", timeout: 120000, maxBuffer: 1e7 },
  );
  const report = JSON.parse(
    readFileSync(`perf-reports/direct-entry/${label}.json`),
  );
  if (result.status !== 0 || report.report.failure || report.errors.length) {
    console.error(result.stdout, result.stderr);
    throw Error(`${label} failed`);
  }
  console.log(label, report.report.curation);
}
