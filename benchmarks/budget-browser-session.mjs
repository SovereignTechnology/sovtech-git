// Run the existing budget scenarios/comparison inside a browser-session lease.
// Start pagination-browser-server.mjs as the local report receiver on port 4190.
// Usage: node benchmarks/budget-browser-session.mjs <lease> <preview-port> <label>
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const [lease, port, label, buildRevision = null] = process.argv.slice(2);
if (!lease || !/^\d+$/.test(port) || !/^[\w-]+$/.test(label ?? ""))
  throw new Error("Pass lease, port, report label");
const source = readFileSync(new URL("./bench.mjs", import.meta.url), "utf8");
// Reuse the authoritative functions and budget constants verbatim. Fail loudly if
// their boundaries move, rather than silently maintaining another set of limits.
const start = source.indexOf("function instrumentWebSockets()");
const end = source.indexOf("// Build + preview + run");
if (start < 0 || end < start)
  throw new Error("bench.mjs section boundaries changed");
const functions = source
  .slice(start, end)
  .replace(/\/\/ -+\s*$/, "")
  .replace(
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "const sleep = (ms) => page.waitForTimeout(ms);",
  );
const baseline = JSON.parse(
  readFileSync(new URL("./baseline.json", import.meta.url)),
);
const code = `async (page) => {
 const QUIET_MS=5000,POLL_MS=500,COLD_TIMEOUT_MS=180000,WARM_TIMEOUT_MS=90000;
 const repoPath='/danconwaydev.com/gitworkshop';
 ${functions}
 const browser=page.context().browser();
 const previousContexts=new Set(browser.contexts());
 try {
 const report={meta:{created:new Date().toISOString(),browser:browser.version(),buildRevision:${JSON.stringify(buildRevision)},benchmarkSourceSha256:${JSON.stringify(createHash("sha256").update(source).digest("hex"))}},...await runScenarios(browser,'http://127.0.0.1:${port}')};
 report.budgetFailed=compare(${JSON.stringify(baseline)},report);
 await page.request.post('http://127.0.0.1:4190/report/${label}',{data:report});
 return {budgetFailed:report.budgetFailed,coldLoad:{...report.coldLoad,perRelay:undefined},warmSwitch:{...report.warmSwitch,perRelay:undefined}};
 } finally { for (const context of browser.contexts()) if (!previousContexts.has(context)) await context.close(); }
}`;
const child = spawnSync(
  "browser-session",
  ["playwright", lease, "run-code", code],
  { encoding: "utf8", maxBuffer: 10e6 },
);
const result = child.stdout?.match(/### Result\n([^\n]+)/)?.[1];
if (child.status !== 0 || !result) {
  console.error(child.stderr || child.stdout || child.error);
  process.exit(1);
}
const report = JSON.parse(result);
console.log(JSON.stringify(report, null, 2));
process.exit(report.budgetFailed ? 1 : 0);
