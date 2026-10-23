// Benchmark-only production bundle. Never use this output for a release.
// Both modes share this bundle; only the priority mode defers repository owners.
import { build, loadConfigFromFile } from "vite";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
      harnessHash: createHash("sha256")
        .update(
          ["build", "run", "server", "suite"]
            .map((name) =>
              readFileSync(
                `benchmarks/direct-entry-browser-${name}.mjs`,
                "utf8",
              ),
            )
            .concat(
              ["journeys", "fixture"].map((name) =>
                readFileSync(`benchmarks/direct-entry-${name}.mjs`, "utf8"),
              ),
            )
            .join("\n"),
        )
        .digest("hex"),
    },
    null,
    2,
  ),
);
const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  path.resolve("vite.config.ts"),
);
const record = `(globalThis as unknown as { __detailBench?: {
  record?: (name: string, value: unknown) => void
} }).__detailBench?.record`;
function replaceOnce(code, target, replacement) {
  if (code.split(target).length !== 2)
    throw Error(`Expected one instrumentation target: ${target}`);
  return code.replace(target, replacement);
}
const injected = `
import { resilientRequest as benchRequest } from "@/lib/resilientSubscription";
import { takeUntil as benchTakeUntil, timer as benchTimer } from "rxjs";
const benchDiagnostic = (globalThis as unknown as { __detailBench?: {
  storeDiagnostics?: boolean;
  inspectStore?: () => unknown;
} }).__detailBench;
if (benchDiagnostic?.storeDiagnostics) {
  const inserted: { id: string; at: number }[] = [];
  eventStore.insert$.subscribe(event => inserted.push({ id: event.id, at: performance.now() }));
  benchDiagnostic.inspectStore = () => ({
    ids: eventStore.getByFilters([{}]).map(event => event.id).sort(),
    inserted: [...inserted],
  });
}
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
        for (const [file, type, kind] of [
          ["useIssues", "ResolvedIssueLite", "issues"],
          ["usePRs", "ResolvedPRLite", "prs"],
        ]) {
          if (id.endsWith(`/src/hooks/${file}.ts`)) {
            return (
              `import { tap as benchTap } from "rxjs";\n` +
              replaceOnce(
                code,
                `) as unknown as Observable<${type}[]>;`,
                `).pipe(benchTap(benchRecordModel)) as unknown as Observable<${type}[]>;`,
              ) +
              `
function benchRecordModel(items: ${type}[]) {
  const b = (globalThis as unknown as { __detailBench?: {
    storeDiagnostics?: boolean;
    modelEmissions?: { at: number; kind: string; rows: { id: string; title: string; status: string }[] }[];
  } }).__detailBench;
  if (b?.storeDiagnostics) (b.modelEmissions ??= []).push({
    at: performance.now(), kind: "${kind}",
    rows: items.map(item => ({ id: item.id, title: item.currentSubject, status: item.status }))
      .sort((a, c) => a.id.localeCompare(c.id)),
  });
}
`
            );
          }
        }
        if (id.endsWith("/src/pages/repo/RepoLayout.tsx")) {
          return replaceOnce(
            code,
            "  // Settings and maintainer-only controls",
            `
  useEffect(() => () => { ${record}?.("repository", null); }, []);
  useEffect(() => {
    const summarise = (items: typeof issues | typeof prs) => !items || !repo ? null :
      items.filter(item => hasAcceptedRepositoryReference(item.repoCoords, repo))
        .map(item => ({ id: item.id, title: item.currentSubject, status: item.status }))
        .sort((a, b) => a.id.localeCompare(b.id));
    ${record}?.("repository", { issues: summarise(issues), prs: summarise(prs) });
  }, [issues, prs, repo]);
  // Settings and maintainer-only controls`,
          );
        }
        for (const [file, item] of [
          ["PRPage", "pr"],
          ["IssuePage", "issue"],
        ]) {
          if (id.endsWith(`/src/pages/${file}.tsx`))
            return replaceOnce(
              code,
              "  const mentionedItems =",
              `
  useEffect(() => () => { ${record}?.("detail", null); }, []);
  useEffect(() => {
    ${record}?.("detail", ${item} ? {
      id: ${item}.id, title: ${item}.currentSubject, status: ${item}.status,
      tip: ${item === "pr" ? "pr.tip.commitId ?? null" : "null"},
      cover: ${item}.coverNote?.id ?? null,
      body: ${item}.body, coverText: ${item}.coverNote?.content ?? null,
    } : null);
  }, [${item}]);
  const mentionedItems =`,
            );
        }
        for (const [file, item, kind] of [
          ["RepoPRsPage", "pr", "prs"],
          ["RepoIssuesPage", "issue", "issues"],
        ]) {
          if (id.endsWith(`/src/pages/repo/${file}.tsx`)) {
            const row =
              kind === "prs"
                ? '<li className="group flex items-start'
                : '<li className="group flex items-stretch';
            return replaceOnce(
              replaceOnce(
                code,
                row,
                `<li data-bench-id={${item}.id} data-bench-title={${item}.currentSubject} data-bench-status={${item}.status} className="group flex ${kind === "prs" ? "items-start" : "items-stretch"}`,
              ),
              '<div className="rounded-lg border border-border overflow-hidden">',
              `<div data-bench-list="${kind}" className="rounded-lg border border-border overflow-hidden">`,
            );
          }
        }
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
