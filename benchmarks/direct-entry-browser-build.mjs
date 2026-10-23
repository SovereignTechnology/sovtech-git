// Benchmark-only production bundle. Never use this output for a release.
// Both modes share this bundle; only the priority mode defers repository owners.
import { build, loadConfigFromFile } from "vite";
import path from "node:path";
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
        return updated + injected;
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
