// Uses only a browser-session-owned browser, with a fresh context for every run.
// Call: node benchmarks/direct-entry-browser-run.mjs <lease>
import { spawnSync } from "node:child_process";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { runJourney } from "./direct-entry-journeys.mjs";
async function run(control) {
  const api = control.request,
    fixture = await (await api.get("http://127.0.0.1:4190/fixture")).json(),
    config = await (await api.get("http://127.0.0.1:4190/config")).json();
  const itemId =
    config.itemId ??
    (config.journey || config.curation ? fixture.journey?.itemId : undefined);
  const selected = itemId
    ? fixture.cases.find((item) => item.id === itemId)
    : fixture.cases[config.case ?? 0];
  if (!selected) throw new Error("Selected item is absent from fixture");
  if (
    config.journey &&
    (!["cold", "return"].includes(config.journey) || !fixture.journey)
  )
    throw Error(
      "Journeys require cold/return and a fixture with journey expectations",
    );
  if (config.journey && selected.id !== fixture.journey.itemId)
    throw Error(
      "Journey item must match the fixture's independently specified expectations",
    );
  for (const key of [
    "phaseMs",
    "navigateAtMs",
    "observationMs",
    "followUpMs",
    "latencyMs",
    "commentLatencyMs",
    "cap",
  ])
    if (
      config[key] !== undefined &&
      (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 120000)
    )
      throw Error(`Invalid ${key}`);
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
    .newContext({ viewport: config.viewport ?? { width: 1440, height: 900 } });
  const errors = [],
    requests = [],
    deliveries = [];
  let pending = 0;
  let updatesReleased = !config.journey;
  const heldIds = new Set(fixture.journey?.updateIds ?? []);
  if (config.journey) {
    for (const key of ["comments", "updates", "essentials"])
      selected[key] = selected[key].filter((id) => !heldIds.has(id));
  }
  if (config.curation === true) {
    const root = fixture.events.find((event) => event.id === selected.id);
    const other = fixture.journey?.initial.prs.find(
      (item) => item.status === "open" && item.id !== selected.id,
    );
    if (
      !root ||
      !other ||
      selected.comments.length === 0 ||
      selected.updates.length === 0
    )
      throw Error(
        "Curation requires the signed synthetic PR fixture with a separate outbox",
      );
    config.curation = {
      commentId: selected.comments[0],
      rootId: other.id,
      curatedTip: root.tags.find((tag) => tag[0] === "c")?.[1],
      expandedTip: fixture.journey.initial.detail.tip,
    };
    config.outboxOnlyIds = [
      selected.comments[0],
      other.id,
      ...selected.updates,
    ];
  }
  const sockets = new Set();
  const hiddenFromRepo = new Set(config.outboxOnlyIds ?? []);
  const available = (event, url) =>
    (updatesReleased || !heldIds.has(event.id)) &&
    (url.includes("outbox.fixture.test") || !hiddenFromRepo.has(event.id));
  let negotiationCount = 0,
    negotiationBytes = 0;
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
      : r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            supported_nips: config.nip77 ? [1, 77] : [1],
          }),
        }),
  );
  await context.routeWebSocket(/.*/, (ws) => {
    const active = new Map();
    const negotiations = new Map();
    const socket = { ws, active, negotiations };
    sockets.add(socket);
    ws.onClose(() => {
      active.clear();
      negotiations.clear();
      sockets.delete(socket);
    });
    ws.onMessage(async (data) => {
      const m = JSON.parse(String(data));
      if (m[0] === "CLOSE") {
        active.delete(m[1]);
        return;
      }
      if (m[0] === "NEG-CLOSE") {
        negotiations.delete(m[1]);
        return;
      }
      if (m[0] === "NEG-OPEN" || m[0] === "NEG-MSG") {
        negotiationCount++;
        negotiationBytes += encodeURIComponent(String(data)).match(
          /%[0-9A-F]{2}|./g,
        ).length;
        if (!config.nip77) {
          ws.send(
            JSON.stringify(["NEG-ERR", m[1], "unsupported: NIP-77 disabled"]),
          );
          return;
        }
        pending++;
        try {
          if (m[0] === "NEG-OPEN") {
            const storage = new NegentropyStorageVector();
            for (const event of fixture.events.filter(
              (e) => available(e, ws.url()) && matches(e, m[2]),
            ))
              storage.insert(event.created_at, event.id);
            storage.seal();
            negotiations.set(m[1], new Negentropy(storage));
          }
          const negotiation = negotiations.get(m[1]);
          if (!negotiation) return;
          const [response] = await negotiation.reconcile(
            m[m[0] === "NEG-OPEN" ? 3 : 2],
          );
          // Model transport delay, not readiness. Cancellation prevents a late reply.
          await page.waitForTimeout(config.latencyMs ?? 20).catch(() => {});
          if (!negotiations.has(m[1])) return;
          const reply = JSON.stringify(["NEG-MSG", m[1], response]);
          negotiationBytes +=
            encodeURIComponent(reply).match(/%[0-9A-F]{2}|./g).length;
          ws.send(reply);
        } catch (error) {
          ws.send(JSON.stringify(["NEG-ERR", m[1], "error: " + String(error)]));
        } finally {
          pending--;
        }
        return;
      }
      if (m[0] !== "REQ") return;
      active.set(m[1], m.slice(2));
      requests.push({ at: Date.now(), url: ws.url(), filters: m.slice(2) });
      pending++;
      // This delay models transport latency; it is not a readiness wait.
      const delay = m.slice(2).some((f) => f["#E"])
        ? (config.commentLatencyMs ?? config.latencyMs ?? 20)
        : (config.latencyMs ?? 20);
      await page.waitForTimeout(delay).catch(() => {});
      pending--;
      if (!active.has(m[1])) return;
      const found = new Map();
      for (const f of m.slice(2))
        for (const e of fixture.events
          .filter((e) => available(e, ws.url()) && matches(e, f))
          .slice(0, Math.min(f.limit ?? config.cap ?? 100, config.cap ?? 100)))
          found.set(e.id, e);
      for (const e of found.values())
        ws.send(JSON.stringify(["EVENT", m[1], e]));
      ws.send(JSON.stringify(["EOSE", m[1]]));
      deliveries.push({ at: Date.now(), count: found.size });
    });
  });
  const releaseUpdates = () => {
    updatesReleased = true;
    for (const { ws, active } of sockets)
      for (const [id, filters] of active)
        for (const event of fixture.events)
          if (
            available(event, ws.url()) &&
            heldIds.has(event.id) &&
            filters.some((f) => matches(event, f))
          )
            ws.send(JSON.stringify(["EVENT", id, event]));
  };
  await context.addInitScript(
    ({ selected, config, repositoryComments, oracleEvents }) => {
      for (const key of ["extraRelays", "lookupRelays", "gitIndexRelays"])
        localStorage.setItem(key, JSON.stringify(["wss://fixture.invalid"]));
      localStorage.setItem("relayCurationMode", '"repo"');
      const b = (window.__detailBench = {
        mode: config.mode,
        strategy: config.strategy,
        storeDiagnostics: config.storeDiagnostics === true,
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
        transitions: { repository: [], detail: [], list: [] },
      });
      b.record = (name, value) => {
        const rows = b.transitions[name];
        if (
          rows.at(-1)?.path !== location.pathname ||
          JSON.stringify(rows.at(-1)?.value) !== JSON.stringify(value)
        )
          rows.push({ at: performance.now(), path: location.pathname, value });
        if (name === "detail") queueMicrotask(() => b.scan?.());
      };
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
        if (config.journey) {
          const list = document.querySelector("[data-bench-list]");
          b.record(
            "list",
            list
              ? {
                  kind: list.dataset.benchList,
                  rows: [...list.querySelectorAll("[data-bench-id]")].map(
                    (row) => ({
                      id: row.dataset.benchId,
                      title:
                        row
                          .querySelector(".font-medium")
                          ?.textContent?.trim() ?? null,
                      status:
                        {
                          Open: "open",
                          Draft: "draft",
                          Closed: "closed",
                          Resolved: "resolved",
                          Merged: "resolved",
                          Deleted: "deleted",
                        }[
                          row
                            .querySelector("svg[aria-label]")
                            ?.getAttribute("aria-label")
                        ] ?? null,
                    }),
                  ),
                }
              : null,
          );
          const detail = b.transitions.detail.at(-1)?.value;
          if (
            detail &&
            [...document.querySelectorAll("h1,h2")].some((el) =>
              el.textContent?.includes(detail.title),
            )
          ) {
            mark("detailHeading");
            const body = document.body.innerText;
            if (detail.body && body.includes(detail.body)) mark("bodyDOM");
            if (detail.coverText && body.includes(detail.coverText))
              mark("coverDOM");
          }
        }
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
      b.scan = scan;
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
  let journey;
  try {
    await page.goto(
      "http://127.0.0.1:" + config.port + fixture.basePath + selected.suffix,
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    if (config.journey)
      journey = await runJourney({
        page,
        config,
        fixture,
        selected,
        releaseUpdates,
        transportState: () => ({
          pending,
          connections: sockets.size,
          subscriptions: [...sockets].reduce(
            (sum, socket) =>
              sum + socket.active.size + socket.negotiations.size,
            0,
          ),
        }),
      });
    // A fixed startup observation window is the measured workload, not a sleep used as evidence of readiness.
    else
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
        transitions: b.transitions,
        store: b.inspectStore?.(),
        modelEmissions: b.modelEmissions,
      };
    });
    if (config.followUpMs) {
      await page.waitForFunction(
        (target) => performance.now() >= target,
        report.observedUntil + config.followUpMs,
        { timeout: config.followUpMs + 10000 },
      );
      // Preserve the original observation; a later recovery is separate evidence.
      report.followUp = await page.evaluate(() => {
        const b = window.__detailBench;
        return {
          observedUntil: performance.now(),
          ids: [...b.events].sort(),
          transitions: b.transitions,
          store: b.inspectStore?.(),
          modelEmissions: b.modelEmissions,
        };
      });
    }
    if (journey) report.journey = journey;
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
    if (config.curation) {
      const id = config.curation.commentId;
      const anchor = page.locator('[id="' + id.slice(0, 15) + '"]');
      const epoch = await page.evaluate(() => performance.timeOrigin);
      const assertTip = async (tip) => {
        if (!tip) return;
        await page.waitForFunction(
          (expected) =>
            window.__detailBench.transitions.detail?.at(-1)?.value?.tip ===
            expected,
          tip,
          { timeout: 15000 },
        );
      };
      await assertTip(config.curation.curatedTip);
      await page
        .getByRole("button", { name: "Include outbox relays", exact: true })
        .first()
        .waitFor();
      if (await anchor.count())
        throw Error("Outbox-only comment leaked into curated view");
      const started = Date.now();
      await page
        .getByRole("button", { name: "Include outbox relays", exact: true })
        .first()
        .click();
      await anchor.waitFor({ state: "visible", timeout: 20000 });
      await assertTip(config.curation.expandedTip);
      const expandedMs = Date.now() - started;
      await page
        .getByRole("button", { name: "Back to curated", exact: true })
        .click();
      await anchor.waitFor({ state: "detached", timeout: 10000 });
      await assertTip(config.curation.curatedTip);
      if ((await page.evaluate(() => performance.timeOrigin)) !== epoch)
        throw Error("Toggle reloaded document");
      if (config.curation.rootId) {
        await page.evaluate((path) => {
          history.pushState(null, "", path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, fixture.basePath + "/prs");
        await page.getByPlaceholder(/^Search PRs,/).waitFor({ timeout: 10000 });
        const row = page.locator(
          '[data-bench-id="' + config.curation.rootId + '"]',
        );
        if (await row.count())
          throw Error("Outbox-only root leaked into curated list");
        await page
          .getByRole("button", { name: "Include outbox relays", exact: true })
          .first()
          .click();
        await row.waitFor({ state: "visible", timeout: 20000 });
        await page
          .getByRole("button", { name: "Back to curated", exact: true })
          .click();
        await row.waitFor({ state: "detached", timeout: 10000 });
      }
      report.curation = { expandedMs, returnedWithoutReload: true };
    }
    if (config.snapshot)
      await page.screenshot({ path: config.snapshot, fullPage: false });
    if (config.navigate && !config.journey) {
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
      finalState: await page.evaluate(() => ({
        store: window.__detailBench?.inspectStore?.(),
        ids: [...(window.__detailBench?.events ?? [])],
        transitions: window.__detailBench?.transitions,
      })),
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
          browserVersion: context.browser().version(),
          report,
          errors,
          requestCount: requests.length,
          transportRequests: requests,
          negotiationCount,
          negotiationBytes,
          pending,
        },
      });
    } finally {
      await context.close();
    }
  }
  if (report?.failure || journey?.failure)
    throw new Error(report?.failure ?? journey.failure);
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
// Bundle the installed protocol codec for the isolated runner, whose VM does
// not permit dynamic imports. No application source or protocol is duplicated.
const codec = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: true,
    lib: {
      entry: fileURLToPath(
        new URL(
          "../node_modules/applesauce-relay/dist/lib/negentropy.js",
          import.meta.url,
        ),
      ),
      name: "benchNegentropy",
      formats: ["iife"],
    },
  },
});
const codecSource = (Array.isArray(codec) ? codec[0] : codec).output.find(
  (item) => item.type === "chunk",
).code;
const child = spawnSync(
  "browser-session",
  [
    "playwright",
    process.argv[2],
    "run-code",
    `async (control) => {
    ${codecSource}
    const { Negentropy, NegentropyStorageVector } = benchNegentropy;
    const runJourney = ${runJourney.toString()};
    return (${run.toString()})(control);
  }`,
  ],
  { encoding: "utf8", maxBuffer: 1e7 },
);
console.log(child.stdout);
console.error(child.stderr);
process.exit(child.status ?? 1);
