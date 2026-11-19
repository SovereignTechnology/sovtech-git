// Uses only the browser-session-owned browser; never launches Chromium directly.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export default async function run(controlPage) {
  const api = controlPage.request;
  const config = await (await api.get("http://127.0.0.1:4190/config")).json();
  const fixture = await (await api.get("http://127.0.0.1:4190/fixture")).json();
  const context = await controlPage
    .context()
    .browser()
    .newContext({ viewport: { width: 1440, height: 900 } });
  const counters = {
    requests: 0,
    filterBytes: 0,
    eventFrames: 0,
    eventBytes: 0,
    unique: new Set(),
    byKind: {},
    requestLog: [],
    closes: 0,
    pending: 0,
    lastDelivery: 0,
  };
  const errors = [];
  const networkFailures = [];
  function matches(e, f) {
    if (f.ids && !f.ids.includes(e.id)) return false;
    if (f.authors && !f.authors.includes(e.pubkey)) return false;
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    if (f.since !== undefined && e.created_at < f.since) return false;
    if (f.until !== undefined && e.created_at > f.until) return false;
    for (const [key, values] of Object.entries(f))
      if (
        key.startsWith("#") &&
        !e.tags.some((t) => t[0] === key.slice(1) && values.includes(t[1]))
      )
        return false;
    if (
      f.search &&
      !`${e.content} ${e.tags.flat().join(" ")}`
        .toLowerCase()
        .includes(f.search.toLowerCase())
    )
      return false;
    return true;
  }
  if (!config.live) {
    await context.route("**/*", (route) =>
      route.request().url().startsWith("http://127.0.0.1:")
        ? route.continue()
        : route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{}",
          }),
    );
    await context.routeWebSocket(/.*/, (ws) => {
      const active = new Set();
      ws.onClose(() => active.clear());
      ws.onMessage(async (message) => {
        const frame = JSON.parse(String(message));
        if (frame[0] === "CLOSE") {
          active.delete(frame[1]);
          counters.closes++;
          return;
        }
        if (frame[0] !== "REQ") return;
        const filters = frame.slice(2);
        counters.requests++;
        counters.filterBytes += encodeURIComponent(
          JSON.stringify(filters),
        ).replace(/%[A-F0-9]{2}/g, "x").length;
        counters.requestLog.push({ at: Date.now(), url: ws.url(), filters });
        active.add(frame[1]);
        counters.pending++;
        try {
          await page.waitForTimeout(config.latencyMs ?? 20);
        } catch {
          counters.pending--;
          return;
        }
        {
          counters.pending--;
          if (!active.has(frame[1])) return;
          const found = new Map();
          for (const f of filters)
            for (const e of fixture.events
              .filter((e) => matches(e, f))
              .slice(
                0,
                config.matchedData
                  ? fixture.events.length
                  : Math.min(
                      f.limit ?? config.defaultLimit ?? 100,
                      config.cap ?? 100,
                    ),
              ))
              found.set(e.id, e);
          for (const e of found.values()) {
            counters.eventFrames++;
            counters.eventBytes += encodeURIComponent(
              JSON.stringify(e),
            ).replace(/%[A-F0-9]{2}/g, "x").length;
            counters.unique.add(e.id);
            counters.byKind[e.kind] = (counters.byKind[e.kind] ?? 0) + 1;
            ws.send(JSON.stringify(["EVENT", frame[1], e]));
          }
          counters.lastDelivery = Date.now();
          ws.send(JSON.stringify(["EOSE", frame[1]]));
        }
      });
    });
  }
  await context.addInitScript(
    ({ fixture, config }) => {
      if (!config.live) {
        for (const key of ["extraRelays", "lookupRelays", "gitIndexRelays"])
          localStorage.setItem(key, JSON.stringify(fixture.defaultRelays));
        localStorage.setItem("relayCurationMode", "repo");
        if (config.scenario === "notifications") {
          localStorage.setItem(
            "accounts",
            JSON.stringify([
              { id: "fixture-reader", type: "extension", pubkey: fixture.user },
            ]),
          );
          localStorage.setItem("active-account", "fixture-reader");
          window.nostr = {
            getPublicKey: async () => fixture.user,
            signEvent: async () => {
              throw new Error("Read-only benchmark signer");
            },
          };
        }
      }
      window.__bench = {
        longTasks: [],
        frames: [],
        inputDelays: [],
        events: new Set(),
        requests: 0,
        filterBytes: 0,
        eventBytes: 0,
        eventFrames: 0,
        errors: [],
        eoses: 0,
      };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          window.__bench.longTasks.push({ at: e.startTime, ms: e.duration });
      }).observe({ type: "longtask", buffered: true });
      let previous = performance.now();
      function frame(t) {
        window.__bench.frames.push(t - previous);
        previous = t;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      const Base = WebSocket;
      window.WebSocket = class extends Base {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (typeof data !== "string") return;
            try {
              const m = JSON.parse(data);
              if (m[0] === "EVENT") {
                window.__bench.events.add(m[2].id);
                window.__bench.eventFrames++;
                window.__bench.eventBytes += new TextEncoder().encode(
                  data,
                ).length;
              }
              if (m[0] === "EOSE") window.__bench.eoses++;
              if (m[0] === "CLOSED") window.__bench.errors.push(m[2]);
            } catch {}
          });
        }
        send(data) {
          try {
            const m = JSON.parse(data);
            if (m[0] === "REQ") {
              window.__bench.requests++;
              window.__bench.filterBytes += new TextEncoder().encode(
                JSON.stringify(m.slice(2)),
              ).length;
            }
          } catch {}
          super.send(data);
        }
      };
    },
    { fixture, config },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) =>
    networkFailures.push({ url: r.url(), error: r.failure()?.errorText }),
  );
  const path = config.live
    ? (config.path ?? "/danconwaydev.com/gitworkshop/issues")
    : config.scenario === "repo"
      ? fixture.repoPath
      : config.scenario === "notifications"
        ? "/notifications"
        : "/search";
  const start = Date.now();
  const milestones = [];
  const capture = async (label) => {
    const metrics = await page.evaluate(async (retainEventIds) => {
      const b = window.__bench;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode([...b.events].sort().join("\n")),
      );
      return {
        profile: window.__gwPerf ? JSON.parse(window.__gwPerf.json()) : null,
        longTasks: b?.longTasks,
        frameMaxMs: b?.frames.length ? Math.max(...b.frames) : null,
        framesOver50: b?.frames.filter((t) => t > 50).length,
        requests: b?.requests,
        filterBytes: b?.filterBytes,
        eventBytes: b?.eventBytes,
        eventFrames: b?.eventFrames,
        unique: b?.events.size,
        eventIds: retainEventIds ? [...b.events].sort() : undefined,
        eventIdsSha256: [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
        eoses: b?.eoses,
        relayErrors: b?.errors,
        heapBytes: performance.memory?.usedJSHeapSize,
        timeOrigin: performance.timeOrigin,
        body: document.body.innerText.slice(0, 1800),
      };
    }, config.retainEventIds);
    milestones.push({ label, elapsedMs: Date.now() - start, metrics });
  };
  let readyMs = null,
    failure = null;
  try {
    await page.goto(`http://127.0.0.1:${config.port}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page
      .locator("#app-splash")
      .waitFor({ state: "detached", timeout: 15000 });
    if (config.scenario === "repo") {
      await page.locator('nav a[href$="/issues"]').waitFor({ timeout: 30000 });
      await page
        .locator('a[href*="/issues/"]')
        .first()
        .waitFor({ timeout: 30000 });
    } else if (config.scenario === "notifications")
      await page
        .getByRole("heading", { name: "Notifications", exact: true })
        .waitFor({ timeout: 15000 });
    else
      await page
        .getByRole("heading", { name: "Repository announcements", exact: true })
        .waitFor({ timeout: 15000 });
    readyMs = Date.now() - start;
    await capture("ready");
    if (config.matchedData) {
      if (config.live)
        throw new Error("Matched data requires controlled replay");
      // Quiet time is the condition under test, not a substitute for readiness.
      // Compare event hashes across variants before interpreting these timings.
      const deadline = Date.now() + 30000;
      while (counters.pending || Date.now() - counters.lastDelivery < 1000) {
        if (Date.now() > deadline) throw new Error("Replay did not settle");
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await capture("matched-data-ready");
    }
    if (config.probeInitialInteraction && config.scenario === "notifications") {
      const interactionStart = Date.now();
      await page.locator('[aria-label="Group notifications by user"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Group notifications by user"]')
            ?.getAttribute("data-state") === "on",
        null,
        { timeout: 5000 },
      );
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const deadline = setTimeout(
              () => reject(new Error("Paint observation deadline exceeded")),
              5000,
            );
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                clearTimeout(deadline);
                resolve();
              }),
            );
          }),
      );
      milestones.push({
        label: "initial-group-painted",
        elapsedMs: Date.now() - start,
        interactionMs: Date.now() - interactionStart,
      });
    }
    if (config.probeRepoInteraction && config.scenario === "repo") {
      const input = page.getByPlaceholder(/^Search issues,/);
      const began = Date.now();
      await input.fill("benchmark-no-matching-subject-8b0ff5");
      await page
        .getByText("No issues match your filters", { exact: true })
        .waitFor({ timeout: 5000 });
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Paint deadline")),
              5000,
            );
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                clearTimeout(timer);
                resolve();
              }),
            );
          }),
      );
      milestones.push({
        label: config.matchedData
          ? "filter-after-matched-data"
          : "filter-during-history-painted",
        interactionMs: Date.now() - began,
        elapsedMs: Date.now() - start,
      });
      await input.fill("");
      await page
        .locator('a[href*="/issues/"]')
        .first()
        .waitFor({ timeout: 5000 });
    }
    // Fixed observation windows measure continuing background work, not readiness.
    await page.waitForTimeout(config.observationMs ?? 20000);
    await capture("cold-observation");
    if (config.scenario === "notifications") {
      const more = page.getByRole("button", { name: /load more/i });
      if (await more.isVisible()) {
        await more.click();
        if (config.probeInteraction) {
          // Read-only local view change while the relay page is outstanding.
          const interactionStart = Date.now();
          const grouping = page.locator(
            '[aria-label="Group notifications by user"]',
          );
          await grouping.click();
          await page.waitForFunction(
            () =>
              document
                .querySelector('[aria-label="Group notifications by user"]')
                ?.getAttribute("data-state") === "on",
            null,
            { timeout: 5000 },
          );
          milestones.push({
            label: "group-during-load",
            elapsedMs: Date.now() - start,
            interactionMs: Date.now() - interactionStart,
          });
        }
        await page.waitForTimeout(10000);
        await capture("load-more");
      }
    } else if (config.scenario === "search") {
      const input = page.getByPlaceholder(/search/i).first();
      if (await input.isVisible()) {
        await input.fill("Performance fixture");
        await input.press("Enter");
        await page.waitForTimeout(10000);
        await capture("search");
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(5000);
        await capture("search-scroll");
      }
    } else {
      const tab = page.locator('nav a[href$="/prs"]');
      if (await tab.count()) {
        const t = Date.now();
        await tab.click();
        await page.waitForURL("**/prs", { timeout: 10000 });
        milestones.push({
          label: "pr-switch",
          elapsedMs: Date.now() - start,
          switchMs: Date.now() - t,
        });
        await page.waitForTimeout(5000);
        await capture("warm-pr");
        if (config.warmReload) {
          const reloadStart = Date.now();
          await page.goto(`http://127.0.0.1:${config.port}${path}`, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await page
            .locator('a[href*="/issues/"]')
            .first()
            .waitFor({ timeout: 30000 });
          milestones.push({
            label: "warm-cache-ready",
            elapsedMs: Date.now() - start,
            readyMs: Date.now() - reloadStart,
          });
          await page.waitForTimeout(config.observationMs ?? 20000);
          await capture("warm-cache-observation");
        }
      }
    }
  } catch (e) {
    failure = String(e);
    await capture("failure").catch(() => {});
  }
  const report = {
    config,
    browser: context.browser().version(),
    fixtureExpected: config.live ? null : fixture.expected,
    fixtureSha256: config.live ? null : fixture.sha256,
    readyMs,
    failure,
    errors,
    networkFailures,
    milestones,
    relayReplay: config.live
      ? null
      : { ...counters, unique: counters.unique.size },
    created: new Date().toISOString(),
  };
  await api.post(`http://127.0.0.1:4190/report/${config.name}`, {
    data: report,
  });
  await context.close();
  return {
    name: config.name,
    readyMs,
    failure,
    errors,
    milestones: milestones.map((m) => ({
      label: m.label,
      elapsedMs: m.elapsedMs,
      requests: m.metrics?.requests,
      unique: m.metrics?.unique,
      frameMaxMs: m.metrics?.frameMaxMs,
      heapMB: m.metrics?.heapBytes / 1e6,
    })),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2])
    throw new Error("Pass a browser-session lease identifier");
  const child = spawnSync(
    "browser-session",
    ["playwright", process.argv[2], "run-code", run.toString()],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}
