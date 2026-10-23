// CI owns this disposable browser. Local agents use the browser-session adapter.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { get } from "node:http";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import run from "./pagination-browser-run.mjs";
import { summarize } from "./replay-report.mjs";

const lease = process.argv[2];
if (!lease && !process.env.NGIT_CI_COMMIT_SHA)
  throw new Error("Run in Nostr CI or pass a browser-session lease");
const commit =
  process.env.NGIT_CI_COMMIT_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const out = "perf-reports/pagination-performance";
mkdirSync(out, { recursive: true });
const services = [];
let browser;
try {
  for (const args of [
    ["benchmarks/pagination-browser-server.mjs"],
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--strictPort",
    ],
  ])
    services.push(spawn(process.execPath, args, { stdio: "inherit" }));
  const deadline = Date.now() + 30000;
  for (const url of [
    "http://127.0.0.1:4190/fixture",
    "http://127.0.0.1:4173",
  ]) {
    while (true) {
      if (services.some((p) => p.exitCode !== null))
        throw new Error("Replay service exited");
      const ready = await new Promise((resolve) => {
        const req = get(url, { signal: AbortSignal.timeout(2000) }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
      });
      if (ready) break;
      if (Date.now() > deadline)
        throw new Error(`Service readiness deadline: ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!lease) browser = await chromium.launch({ headless: true });
  const control = browser ? await browser.newPage() : null;
  const reports = [];
  // A discarded warmup loads OS caches; every measured sample has a fresh context.
  for (let i = -1; i < 5; i++) {
    const config = {
      port: 4173,
      revision: commit,
      scenario: "repo",
      name: `ci-${i < 0 ? "warmup" : i}`,
      live: false,
      matchedData: true,
      retainEventIds: true,
      probeRepoInteraction: true,
      observationMs: 0,
    };
    writeFileSync(`${out}/browser-config.json`, JSON.stringify(config));
    if (lease)
      execFileSync(
        "browser-session",
        ["playwright", lease, "run-code", run.toString()],
        { stdio: "ignore", timeout: 120000 },
      );
    else await run(control);
    const report = JSON.parse(readFileSync(`${out}/${config.name}.json`));
    if (report.failure || report.errors.length || report.networkFailures.length)
      throw new Error(`Replay failed: ${JSON.stringify(report)}`);
    if (i >= 0) reports.push(report);
  }
  const hash = (paths) =>
    createHash("sha256")
      .update(paths.map((p) => readFileSync(p)).join("\n"))
      .digest("hex");
  const report = {
    commit,
    lockSha256: hash(["pnpm-lock.yaml"]),
    harnessSha256: hash([
      "benchmarks/pagination-browser-run.mjs",
      "benchmarks/pagination-browser-server.mjs",
      "benchmarks/ci-replay.mjs",
      "benchmarks/replay-report.mjs",
    ]),
    node: process.version,
    resources: process.env.NGIT_CI_RESOURCES ?? null,
    trackedDiff: execFileSync("git", ["diff", "HEAD", "--stat"], {
      encoding: "utf8",
    }),
    summary: summarize(reports),
    reports,
  };
  writeFileSync(`${out}/summary.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
} finally {
  await browser?.close();
  for (const service of services) service.kill("SIGTERM");
}
