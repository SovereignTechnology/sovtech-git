// Benchmark-only production bundle. Never use this output for a release.
// Both modes share this bundle; only the priority mode defers repository owners.
import { build, loadConfigFromFile } from "vite";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync("perf-reports/direct-entry", { recursive: true });
writeFileSync(
  "perf-reports/direct-entry/build-meta.json",
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      diffHash: createHash("sha256")
        .update(execFileSync("git", ["diff", "HEAD"]))
        .digest("hex"),
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  path.resolve("vite.config.ts"),
);
const injected = `
import { resilientRequest as benchRequest } from "@/lib/resilientSubscription";
import { takeUntil as benchTakeUntil, timer as benchTimer } from "rxjs";
const benchOracle = (globalThis as unknown as { __detailBench?: { oracleEvents?: import("nostr-tools").NostrEvent[] } }).__detailBench?.oracleEvents;
if (benchOracle) for (const event of benchOracle) eventStore.add(event);
function benchStrategy() {
  return (globalThis as unknown as { __detailBench?: { strategy: string } }).__detailBench?.strategy;
}
export function benchDetailList(itemId: string, relays: string[]) {
  const strategy = benchStrategy();
  if (!strategy || strategy === "shared") return nip34ListLoader(itemId, relays);
  const essentials = nip34ItemEssentialsLoader(itemId, relays);
  if (strategy !== "one-shot") return essentials;
  // Finite initial preview only: persistent thread loading still owns history.
  return merge(essentials, benchRequest(pool, relays, [{
    kinds: [1111, 1619, ...CI_EVENT_KINDS], "#E": [itemId],
  }], { paginate: false }).pipe(
    benchTakeUntil(benchTimer(3000)), onlyEvents(), mapEventsToStore(eventStore),
  ));
}
const benchRootLoaders = ["e", "E", "q"].map(tag =>
  createPaginatedTagValueLoader(pool, tag, { cacheRequest, eventStore, bufferTime: NIP34_THREAD_BUFFER, bufferSize: 1 }),
);

function benchPriority<T>(factory: () => Observable<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const b = (globalThis as unknown as {
      __detailBench?: {
        mode: string;
        gate: boolean;
        marks: Record<string, number>;
        releaseReason?: string;
      };
    }).__detailBench;
    if (!b || b.mode !== 'priority' || b.gate)
      return factory().subscribe(subscriber);

    b.marks.gateStart ??= performance.now();
    let started = false;
    const start = () => {
      if (started || subscriber.closed) return;
      started = true;
      b.marks.gateReleased ??= performance.now();
      b.releaseReason ??= 'comment-paint-opportunity';
      subscriber.add(factory().subscribe(subscriber));
    };
    window.addEventListener('detail-bench-ready', start);
    const deadline = setTimeout(() => {
      b.gate = true;
      b.releaseReason ??= 'deadline';
      window.dispatchEvent(new Event('detail-bench-ready'));
    }, Math.max(0, 3000 - (performance.now() - b.marks.gateStart)));
    return () => {
      clearTimeout(deadline);
      window.removeEventListener('detail-bench-ready', start);
    };
  });
}
export function nip34RepoLoader(...args: Parameters<typeof benchActualRepoLoader>) {
  return benchPriority(() => benchActualRepoLoader(...args));
}
export function nip34SupplementalRelayLoader(...args: Parameters<typeof benchActualSupplementalLoader>) {
  return benchPriority(() => benchActualSupplementalLoader(...args));
}
`;
await build({
  ...loaded.config,
  configFile: false,
  plugins: [
    {
      name: "direct-entry-experiment",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/src/hooks/useNip34Loaders.ts")) {
          if (!code.includes("  nip34ListLoader,"))
            throw Error("detail import missing");
          return code.replace(
            "  nip34ListLoader,",
            "  benchDetailList as nip34ListLoader,",
          );
        }
        if (!id.endsWith("/src/services/nostr.ts")) return;
        if (
          !code.includes("export function nip34RepoLoader(") ||
          !code.includes("export function nip34SupplementalRelayLoader(")
        )
          throw Error("instrumentation target missing");
        const updated = code
          .replace(
            "export function nip34RepoLoader(",
            "function benchActualRepoLoader(",
          )
          .replace(
            "export function nip34SupplementalRelayLoader(",
            "function benchActualSupplementalLoader(",
          );
        if (updated === code) throw Error("instrumentation target missing");
        const original =
          "return loadEventReferenceClosure(itemId, relays, nip34ThreadLoadAll);";
        if (!updated.includes(original)) throw Error("thread target missing");
        return (
          updated.replace(
            original,
            `return loadEventReferenceClosure(itemId, relays, (id, urls) =>
          benchStrategy() === "immediate-root" && id === itemId
            ? merge(...benchRootLoaders.map(loader => loader({ value: id, relays: urls })))
            : nip34ThreadLoadAll(id, urls));`,
          ) + injected
        );
      },
    },
    ...loaded.config.plugins,
  ],
  build: {
    ...loaded.config.build,
    outDir: "perf-reports/direct-entry/dist",
    emptyOutDir: true,
  },
  logLevel: "error",
});
