// Summarise raw reports without treating incomplete work as a speedup.
// Usage: node benchmarks/transfer-diagnostics-summary.mjs <report.json> [...]
import { readFileSync } from "node:fs";
const stats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: sorted.length
      ? (sorted[Math.floor((sorted.length - 1) / 2)] +
          sorted[Math.ceil((sorted.length - 1) / 2)]) /
        2
      : null,
    max: sorted.at(-1) ?? null,
  };
};
const rows = process.argv.slice(2).map((path) => {
  const raw = JSON.parse(readFileSync(path));
  const r = raw.report;
  const trace = r.trace ?? r.finalState?.trace ?? [];
  const advertised = new Map(),
    requested = new Map(),
    received = new Map();
  const rootChoices = new Map();
  const rootRequests = new Map();
  let admissionRefusals = 0;
  const admission = [],
    batches = [],
    active = new Map();
  const negotiationQueue = new Map(),
    negotiationWait = [];
  for (const { at, stage, value: v } of trace) {
    if (stage === "wire-send" && v.type === "REQ") {
      const root = v.filters.find((f) => f.kinds?.includes(1621) && f["#a"]);
      if (root && !rootRequests.has(v.relay))
        rootRequests.set(v.relay, {
          at,
          mode: root.since === undefined ? "initial-snapshot" : "live-only",
          filter: root,
        });
    }
    if (
      stage === "history-choice" &&
      v.query.kinds?.includes(1621) &&
      v.query["#a"] &&
      !rootChoices.has(v.relay)
    )
      rootChoices.set(v.relay, {
        at,
        mode: v.mode,
        inventoryCount: v.inventoryCount,
      });
    // FIFO matching by filter is an estimate: identical cancelled owners can
    // leave an unmatched enqueue. Inspect raw traces before assigning causality.
    if (stage === "negotiation-queued" || stage === "negotiation-start") {
      const key = JSON.stringify([v.relay, v.query]);
      const waiting = negotiationQueue.get(key) ?? [];
      if (stage === "negotiation-queued") waiting.push(at);
      else if (waiting.length) negotiationWait.push(at - waiting.shift());
      negotiationQueue.set(key, waiting);
    }
    if (stage === "negotiation-complete")
      for (const id of v.missing)
        if (!advertised.has(id)) advertised.set(id, at);
    if (stage === "wire-send" && v.type === "REQ")
      for (const f of v.filters)
        for (const id of f.ids ?? [])
          if (!requested.has(id)) requested.set(id, { at, relay: v.relay });
    if (stage === "wire-receive" && v.type === "EVENT" && !received.has(v.id))
      received.set(v.id, at);
    if (stage === "admission") {
      if (v.rejected) admissionRefusals++;
      else admission.push(v.waitMs);
    }
    if (stage === "batch") active.set(v.relay, { at, count: v.ids.length });
    if (stage === "finish") {
      const start = active.get(v.relay);
      if (start)
        batches.push({
          relay: v.relay,
          count: start.count,
          duration: at - start.at,
          remaining: v.pending.length,
          error: v.error,
        });
      active.delete(v.relay);
    }
  }
  const pending = [],
    queue = [],
    wire = [];
  for (const [id, at] of advertised) {
    const request = requested.get(id),
      body = received.get(id);
    if (body === undefined) pending.push(id);
    if (request && request.at >= at) queue.push(request.at - at);
    if (request && body >= request.at) wire.push(body - request.at);
  }
  return {
    path,
    rootRequests: Object.fromEntries(rootRequests),
    rootRequestMode: rootRequests.size
      ? [...new Set([...rootRequests.values()].map((v) => v.mode))]
          .sort()
          .join("+")
      : "unobserved",
    rootChoices: Object.fromEntries(rootChoices),
    rootMode: rootChoices.size
      ? [...new Set([...rootChoices.values()].map((v) => v.mode))]
          .sort()
          .join("+")
      : "unobserved",
    label: raw.config.label,
    failure: r.failure ?? r.journey?.failure ?? null,
    errors: raw.errors,
    comments: r.marks?.firstCommentPaintOpportunity ?? null,
    allComments: r.marks?.allCommentsPaintOpportunity ?? null,
    coverage: Object.fromEntries(
      Object.entries(r.coverage ?? {}).map(([k, v]) => [
        k,
        {
          missing: v.missing.length,
          firstAt: v.firstAt,
          completeAt: v.completeAt,
        },
      ]),
    ),
    checkpoints: (r.checkpoints ?? r.finalState?.checkpoints ?? []).map(
      (c) => ({
        target: c.target,
        at: c.at,
        unique: c.ids.length,
        missing: Object.fromEntries(
          Object.entries(c.coverage).map(([k, v]) => [k, v.length]),
        ),
        eventBytes: c.eventBytes,
        longTaskMs: c.longTaskMs,
        frameMax: c.frameMax,
      }),
    ),
    traceDropped: r.traceDropped ?? r.finalState?.traceDropped,
    faultRequests: raw.faults?.length ?? 0,
    advertised: advertised.size,
    pendingAdvertised: pending,
    advertisementToFirstIdRequest: stats(queue),
    firstIdRequestToFirstReceipt: stats(wire),
    admissionReservation: stats(admission),
    admissionRefusals,
    negotiationQueueWaitEstimate: stats(negotiationWait),
    batches: batches.sort((a, b) => b.duration - a.duration).slice(0, 10),
    journey: r.journey,
  };
});
console.log(JSON.stringify(rows, null, 2));
