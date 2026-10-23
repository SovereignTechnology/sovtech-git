// Compact the raw browser replay captures without changing measurement values.
// Usage: node benchmarks/dependency-browser-report.mjs <capture-directory>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = process.argv[2];
if (!root)
  throw new Error("Pass the directory containing dependency browser captures");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const runs = readdirSync(root)
  .filter((name) =>
    /^dependency-(repo|notifications)-v[67]-(production|profile)-\d+\.json$/.test(
      name,
    ),
  )
  .sort()
  .map((name) => {
    const raw = readFileSync(join(root, name));
    const run = JSON.parse(raw);
    assert.equal(run.failure, null, name);
    assert.deepEqual(run.errors, [], name);
    return {
      rawFile: name,
      rawSha256: sha256(raw),
      config: run.config,
      browser: run.browser,
      created: run.created,
      readyMs: run.readyMs,
      failure: run.failure,
      errors: run.errors,
      networkFailures: run.networkFailures,
      milestones: run.milestones.map(({ metrics, ...milestone }) => {
        if (!metrics) return milestone;
        const { body, profile, ...values } = metrics;
        return {
          ...milestone,
          metrics: {
            ...values,
            profile: profile
              ? {
                  commit: profile.commit,
                  runtime: {
                    windowSec: profile.runtime.windowSec,
                    frames: profile.runtime.frames,
                    react: profile.runtime.react,
                    store: profile.runtime.store,
                    cacheQueries: profile.runtime.cacheQueries,
                  },
                }
              : null,
          },
        };
      }),
      relayReplay: { ...run.relayReplay, requestLog: undefined },
    };
  });
// Check observed identities, not just event counts, at each stable observation.
const comparisons = [];
for (const build of ["production", "profile"])
  for (const scenario of ["repo", "notifications"]) {
    const selected = runs.filter(
      (r) => r.config.build === build && r.config.scenario === scenario,
    );
    if (!selected.length) continue;
    const pairCount = build === "production" ? 3 : 2;
    assert.equal(selected.length, pairCount * 2, `${build}/${scenario} pairs`);
    for (const phase of scenario === "repo"
      ? ["cold-observation", "warm-pr", "warm-cache-observation"]
      : ["cold-observation", "load-more"]) {
      const values = selected.map(
        (r) => r.milestones.find((m) => m.label === phase)?.metrics,
      );
      assert.ok(
        values.every((m) => m?.eventIdsSha256),
        `${build}/${scenario}/${phase}: missing identity hash`,
      );
      assert.equal(
        new Set(values.map((m) => m.eventIdsSha256)).size,
        1,
        `${build}/${scenario}/${phase}: unequal event identities`,
      );
      comparisons.push({
        build,
        scenario,
        phase,
        runs: values.length,
        eventIdsSha256: values[0].eventIdsSha256,
        unique: values[0].unique,
        requests: values.map((v) => v.requests),
      });
    }
  }
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      fixtureSha256: sha256(readFileSync(join(root, "fixture.json"))),
      method:
        "Fresh Chromium contexts, alternating AB/BA pairs. Synthetic signed fixture and HTTP stubs, 20ms relay delay, fixed 2s background observations, same-context repository reload. Production is primary; profile runs support attribution. Pilot repository runs before identity hashing are excluded and retained locally. No live-relay, physical-phone, retained-heap or total browser CPU claim.",
      comparisons,
      runs,
    },
    null,
    2,
  ),
);
