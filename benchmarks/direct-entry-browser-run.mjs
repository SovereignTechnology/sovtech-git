// Uses only a browser-session-owned browser, with a fresh context for every run.
// Call: node benchmarks/direct-entry-browser-run.mjs <lease>
import { spawnSync } from "node:child_process";
async function run(control) {
  const api = control.request,
    fixture = await (await api.get("http://127.0.0.1:4190/fixture")).json(),
    config = await (await api.get("http://127.0.0.1:4190/config")).json();
  const selected = config.itemId
    ? fixture.cases.find((item) => item.id === config.itemId)
    : fixture.cases[config.case ?? 0];
  if (!selected) throw new Error("Selected item is absent from fixture");
  if (!["baseline", "priority"].includes(config.mode))
    throw new Error("Mode must be baseline or priority");
  if (!/^[a-zA-Z0-9_-]+$/.test(config.label ?? ""))
    throw new Error("Invalid report label");
  config.strategy ??= "shared";
  if (
    !["shared", "thread-only", "one-shot", "immediate-root"].includes(
      config.strategy,
    )
  )
    throw new Error("Unknown query strategy");
  const context = await control
    .context()
    .browser()
    .newContext({ viewport: { width: 1440, height: 900 } });
  const errors = [],
    requests = [],
    deliveries = [];
  let pending = 0;
  const matches = (e, f) =>
    !(
      (f.ids && !f.ids.includes(e.id)) ||
      (f.authors && !f.authors.includes(e.pubkey)) ||
      (f.kinds && !f.kinds.includes(e.kind)) ||
      (f.since !== undefined && e.created_at < f.since) ||
      (f.until !== undefined && e.created_at > f.until)
    ) &&
    Object.entries(f).every(
      ([k, v]) =>
        !k.startsWith("#") ||
        e.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1])),
    );
  await context.route("**/*", (r) =>
    r.request().url().startsWith("http://127.0.0.1:")
      ? r.continue()
      : r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await context.routeWebSocket(/.*/, (ws) => {
    const active = new Set();
    ws.onClose(() => active.clear());
    ws.onMessage(async (data) => {
      const m = JSON.parse(String(data));
      if (m[0] === "CLOSE") {
        active.delete(m[1]);
        return;
      }
      if (m[0] !== "REQ") return;
      active.add(m[1]);
      requests.push({ at: Date.now(), url: ws.url(), filters: m.slice(2) });
      pending++;
      // This delay models transport latency; it is not a readiness wait.
      await page.waitForTimeout(config.latencyMs ?? 20).catch(() => {});
      pending--;
      if (!active.has(m[1])) return;
      const found = new Map();
      for (const f of m.slice(2))
        for (const e of fixture.events
          .filter((e) => matches(e, f))
          .slice(0, Math.min(f.limit ?? config.cap ?? 100, config.cap ?? 100)))
          found.set(e.id, e);
      for (const e of found.values())
        ws.send(JSON.stringify(["EVENT", m[1], e]));
      ws.send(JSON.stringify(["EOSE", m[1]]));
      deliveries.push({ at: Date.now(), count: found.size });
    });
  });
  await context.addInitScript(
    ({ selected, config, repositoryComments, oracleEvents }) => {
      for (const key of ["extraRelays", "lookupRelays", "gitIndexRelays"])
        localStorage.setItem(key, JSON.stringify(["wss://fixture.invalid"]));
      localStorage.setItem("relayCurationMode", '"repo"');
      const b = (window.__detailBench = {
        mode: config.mode,
        strategy: config.strategy,
        oracleEvents,
        coverage: Object.fromEntries(
          Object.entries({
            comments: selected.comments,
            updates: selected.updates,
            essentials: selected.essentials,
            repositoryComments,
          }).map(([name, ids]) => [
            name,
            {
              expected: ids.length,
              missing: new Set(ids),
              firstAt: null,
              completeAt: null,
            },
          ]),
        ),
        openPRCounts: [],
        root: selected.id,
        title: selected.title,
        comments: selected.comments,
        marks: {},
        longTasks: [],
        frames: [],
        events: new Set(),
        eventFrames: 0,
        eventBytes: 0,
        requests: [],
        gate: false,
      });
      const mark = (name) => {
        if (b.marks[name] !== undefined) return;
        b.marks[name] = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            b.marks[name + "PaintOpportunity"] = performance.now();
            if (name === "firstComment") {
              b.gate = true;
              window.dispatchEvent(new Event("detail-bench-ready"));
            }
          }),
        );
      };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          b.longTasks.push({ at: e.startTime, ms: e.duration });
      }).observe({ type: "longtask", buffered: true });
      let previous = performance.now();
      const frame = (t) => {
        b.frames.push({ at: t, ms: t - previous });
        previous = t;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const scan = () => {
        if (
          selected.title &&
          [...document.querySelectorAll("h1,h2")].some((e) =>
            e.textContent?.includes(selected.title),
          )
        )
          mark("title");
        const countText = document.querySelector(
          'nav a[href$="/prs"]',
        )?.textContent;
        const count = countText?.match(/PRs\s*(\d+)/)?.[1];
        if (
          count !== undefined &&
          b.openPRCounts.at(-1)?.count !== Number(count)
        )
          b.openPRCounts.push({ at: performance.now(), count: Number(count) });
        const present = selected.comments.filter((id) =>
          document.getElementById(id.slice(0, 15)),
        );
        if (present.length) mark("firstComment");
        if (
          selected.comments.length > 0 &&
          present.length === selected.comments.length
        )
          mark("allComments");
      };
      new MutationObserver(scan).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      const Base = WebSocket;
      window.WebSocket = class extends Base {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (typeof data !== "string") return;
            try {
              const m = JSON.parse(data);
              if (m[0] === "EVENT") {
                b.events.add(m[2].id);
                for (const coverage of Object.values(b.coverage)) {
                  if (coverage.missing.delete(m[2].id)) {
                    coverage.firstAt ??= performance.now();
                    if (!coverage.missing.size)
                      coverage.completeAt = performance.now();
                  }
                }
                b.eventFrames++;
                b.eventBytes += new TextEncoder().encode(data).length;
                if (m[2].id === selected.id) mark("rootReceived");
                if (m[2].kind === 1111 && selected.comments.includes(m[2].id))
                  mark("commentReceived");
              }
            } catch {}
          });
        }
        send(data) {
          try {
            const m = JSON.parse(data);
            if (m[0] === "REQ")
              b.requests.push({
                at: performance.now(),
                url: this.url,
                filters: m.slice(2),
              });
          } catch {}
          super.send(data);
        }
      };
    },
    {
      selected,
      config,
      repositoryComments: fixture.repositoryComments,
      oracleEvents: config.fullSnapshotReference ? fixture.events : undefined,
    },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  let report;
  try {
    await page.goto(
      "http://127.0.0.1:" + config.port + fixture.basePath + selected.suffix,
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    // A fixed startup observation window is the measured workload, not a sleep used as evidence of readiness.
    await page.waitForFunction(
      (target) => performance.now() >= target,
      config.observationMs ?? 12000,
      { timeout: (config.observationMs ?? 12000) + 10000 },
    );
    report = await page.evaluate(() => {
      const b = window.__detailBench;
      return {
        observedUntil: performance.now(),
        marks: b.marks,
        coverage: Object.fromEntries(
          Object.entries(b.coverage).map(([name, c]) => [
            name,
            {
              ...c,
              missing: [...c.missing],
              status:
                c.expected === 0
                  ? "not-applicable"
                  : c.missing.size
                    ? "incomplete"
                    : "complete",
            },
          ]),
        ),
        openPRCounts: b.openPRCounts,
        longTasks: b.longTasks,
        frameMax: Math.max(...b.frames.map((x) => x.ms)),
        framesOver50: b.frames.filter((x) => x.ms > 50).length,
        requests: b.requests,
        eventFrames: b.eventFrames,
        eventBytes: b.eventBytes,
        unique: b.events.size,
        ids: [...b.events].sort(),
        gate: b.gate,
        releaseReason: b.releaseReason,
        body: document.body.innerText.slice(0, 2000),
        anchors: b.comments.filter((id) =>
          document.getElementById(id.slice(0, 15)),
        ),
      };
    });
    if (config.expectedOpenPRCount !== undefined) {
      const counts = report.openPRCounts;
      const lastWrong = counts.findLastIndex(
        (x) => x.count !== config.expectedOpenPRCount,
      );
      report.openPRCountReference = {
        expected: config.expectedOpenPRCount,
        final: counts.at(-1)?.count ?? null,
        correctThroughEndFrom:
          counts.at(-1)?.count === config.expectedOpenPRCount
            ? (counts[lastWrong + 1]?.at ?? null)
            : null,
      };
    }
    if (config.snapshot)
      await page.screenshot({ path: config.snapshot, fullPage: false });
    if (config.navigate) {
      const rootCount = () =>
        page.evaluate(
          () =>
            window.__detailBench.requests.filter((r) =>
              r.filters.some(
                (f) =>
                  f["#a"] &&
                  f.kinds?.includes(1621) &&
                  f.since === undefined &&
                  f.until === undefined,
              ),
            ).length,
        );
      const before = await rootCount();
      await page.locator('nav a[href$="/prs"]').click();
      await page.getByPlaceholder(/^Search PRs,/).waitFor({ timeout: 10000 });
      await page.evaluate((path) => {
        history.pushState(null, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, fixture.basePath + selected.suffix);
      await page.waitForFunction(
        (id) => !!document.getElementById(id.slice(0, 15)),
        selected.comments[0],
        { timeout: 10000 },
      );
      report.navigation = { before, after: await rootCount() };
    }
  } catch (e) {
    report = {
      ...report,
      failure: String(e),
      body: await page.locator("body").innerText(),
    };
  } finally {
    try {
      const metaResponse = await api.get("http://127.0.0.1:4190/build-meta");
      const build = metaResponse.ok() ? await metaResponse.json() : null;
      await api.post("http://127.0.0.1:4190/report/" + config.label, {
        data: {
          config,
          build,
          selected,
          corpusHash: fixture.corpusHash,
          report,
          errors,
          requestCount: requests.length,
          pending,
        },
      });
    } finally {
      await context.close();
    }
  }
  if (report?.failure) throw new Error(report.failure);
  return {
    label: config.label,
    marks: report?.marks,
    failure: report?.failure,
    errors,
    requests: report?.requests?.length,
    unique: report?.unique,
    body: report?.body?.slice(0, 600),
  };
}
const child = spawnSync(
  "browser-session",
  ["playwright", process.argv[2], "run-code", run.toString()],
  { encoding: "utf8", maxBuffer: 1e7 },
);
console.log(child.stdout);
console.error(child.stderr);
process.exit(child.status ?? 1);
