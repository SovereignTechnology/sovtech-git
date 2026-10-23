/**
 * Runtime profiler for `pnpm build:profile` builds: what the app costs while
 * it loads and sits idle. Instruments long animation frames (attributed to
 * scripts, Chromium only), relay traffic per socket (REQs grouped by filter
 * SHAPE to spot churn), timers by call site, React commits with per-component
 * render attribution, EventStore inserts by kind, and 10s samples (heap, DOM
 * nodes, sockets).
 *
 * PROFILING BUILDS ONLY: the probes patch page globals. Installed via
 * `perfRuntimeInstall.ts`, which must run before react-dom evaluates and
 * before any socket opens.
 *
 * Console: `__gwPerf.json()`, `__gwPerf.reset()`, `__gwPerf.renders(on)`.
 * See benchmarks/README.md for capture and comparison instructions.
 */

function now(): number {
  return performance.now();
}

interface Agg {
  count: number;
  total: number;
  max: number;
  layout: number;
}

function addTo(map: Map<string, Agg>, key: string, ms = 0): Agg {
  let a = map.get(key);
  if (!a) {
    a = { count: 0, total: 0, max: 0, layout: 0 };
    map.set(key, a);
  }
  a.count += 1;
  a.total += ms;
  if (ms > a.max) a.max = ms;
  return a;
}

interface RenderAgg {
  renders: number;
  mounts: number;
  selfMs: number;
  why: Map<string, number>;
}

interface ShapeAgg {
  reqs: number;
  events: number;
  textChars: number;
  eose: number;
}

/** Everything that resets with the measurement window. */
const state = {
  windowStart: now(),
  frameApi: "none" as "loaf" | "longtask" | "none",
  frames: { count: 0, total: 0, blocking: 0, max: 0, layout: 0 },
  scripts: new Map<string, Agg>(),
  commits: 0,
  commitMs: 0,
  renders: new Map<string, RenderAgg>(),
  timeoutCalls: 0,
  rafCalls: 0,
  timeoutSites: new Map<string, number>(),
  rafSites: new Map<string, number>(),
  shapes: new Map<string, ShapeAgg>(),
  eventsByKind: new Map<number, { count: number; textChars: number }>(),
  storeInserts: new Map<number, number>(),
  storeUpdates: 0,
  storeRemoves: 0,
  cacheQueries: new Map<string, Agg & { events: number }>(),
};

function resetWindow(): void {
  state.windowStart = now();
  state.frames = { count: 0, total: 0, blocking: 0, max: 0, layout: 0 };
  state.scripts.clear();
  state.commits = 0;
  state.commitMs = 0;
  state.renders.clear();
  state.timeoutCalls = 0;
  state.rafCalls = 0;
  state.timeoutSites.clear();
  state.rafSites.clear();
  state.shapes.clear();
  state.eventsByKind.clear();
  state.storeInserts.clear();
  state.storeUpdates = 0;
  state.storeRemoves = 0;
  state.cacheQueries.clear();
  for (const s of relays.values()) {
    const keep = { open: s.open, liveSubs: s.liveSubs, peakSubs: s.liveSubs };
    Object.assign(s, emptyRelayStats(), keep);
  }
  for (const rec of liveIntervals.values()) rec.fires = 0;
}

/** First `depth` caller frames below `skip`, origins and queries stripped. */
function callSite(stack: string | undefined, skip = 1, depth = 3): string {
  if (!stack) return "?";
  const frames = stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /:\d+:\d+\)?$/.test(l));
  const picked = frames
    .slice(skip, skip + depth)
    .map((l) => scrubUrls(l.replace(/^at\s+/, "")));
  return picked.length > 0 ? picked.join(" < ") : "?";
}

function scrubUrls(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^/)\s]*/gi, "")
    .replace(/\?[^:)\s]*/g, "");
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** Filter list reduced to its SHAPE: kinds verbatim, other keys by name and value count. */
function filterShape(filters: unknown[]): string {
  return filters
    .map((f) => {
      if (!f || typeof f !== "object") return "?";
      const rec = f as Record<string, unknown>;
      const parts: string[] = [];
      if (Array.isArray(rec.kinds)) {
        parts.push(
          `kinds:${[...rec.kinds].sort((a, b) => Number(a) - Number(b)).join(",")}`,
        );
      }
      for (const key of Object.keys(rec).sort()) {
        if (key === "kinds") continue;
        const v = rec[key];
        parts.push(Array.isArray(v) ? `${key}×${v.length}` : key);
      }
      return `{${parts.join(" ")}}`;
    })
    .join(" ");
}

function frameHead(data: string): { verb: string; sub?: string } | undefined {
  const m = /^\s*\[\s*"([A-Z]+)"\s*(?:,\s*"((?:[^"\\]|\\.)*)")?/.exec(
    data.slice(0, 256),
  );
  if (!m) return undefined;
  return m[2] === undefined ? { verb: m[1] } : { verb: m[1], sub: m[2] };
}

interface LoafScript {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
}

function installFrameObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (supported.includes("long-animation-frame")) {
    state.frameApi = "loaf";
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & {
          blockingDuration?: number;
          scripts?: LoafScript[];
        };
        state.frames.count += 1;
        state.frames.total += e.duration;
        state.frames.blocking += e.blockingDuration ?? 0;
        if (e.duration > state.frames.max) state.frames.max = e.duration;
        for (const s of e.scripts ?? []) {
          const where = s.sourceURL
            ? `${pathOf(s.sourceURL)}:${s.sourceCharPosition ?? "?"}`
            : "";
          const key = [
            s.invokerType,
            s.invoker && scrubUrls(s.invoker),
            s.sourceFunctionName && `fn ${s.sourceFunctionName}`,
            where,
          ]
            .filter(Boolean)
            .join(" · ");
          const agg = addTo(state.scripts, key, s.duration);
          agg.layout += s.forcedStyleAndLayoutDuration ?? 0;
          state.frames.layout += s.forcedStyleAndLayoutDuration ?? 0;
        }
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } else if (supported.includes("longtask")) {
    state.frameApi = "longtask";
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.frames.count += 1;
        state.frames.total += e.duration;
        state.frames.blocking += Math.max(0, e.duration - 50);
        if (e.duration > state.frames.max) state.frames.max = e.duration;
      }
    }).observe({ type: "longtask", buffered: true });
  }
}

interface RelayStats {
  opened: number;
  open: number;
  textCharsIn: number;
  reqs: number;
  closes: number;
  publishes: number;
  events: number;
  eose: number;
  closed: number;
  notices: number;
  auths: number;
  liveSubs: number;
  peakSubs: number;
}

function emptyRelayStats(): RelayStats {
  return {
    opened: 0,
    open: 0,
    textCharsIn: 0,
    reqs: 0,
    closes: 0,
    publishes: 0,
    events: 0,
    eose: 0,
    closed: 0,
    notices: 0,
    auths: 0,
    liveSubs: 0,
    peakSubs: 0,
  };
}

const relays = new Map<string, RelayStats>();
const socketSubs = new WeakMap<WebSocket, Map<string, string>>();
const socketKeys = new WeakMap<WebSocket, string>();

function relayStats(key: string): RelayStats {
  let s = relays.get(key);
  if (!s) {
    s = emptyRelayStats();
    relays.set(key, s);
  }
  return s;
}

function subsOf(ws: WebSocket): Map<string, string> {
  let m = socketSubs.get(ws);
  if (!m) {
    m = new Map();
    socketSubs.set(ws, m);
  }
  return m;
}

function shapeAgg(shape: string): ShapeAgg {
  let a = state.shapes.get(shape);
  if (!a) {
    a = { reqs: 0, events: 0, textChars: 0, eose: 0 };
    state.shapes.set(shape, a);
  }
  return a;
}

/**
 * Request waterfall: when each REQ was sent, when its first EVENT and its
 * EOSE arrived (ms since page load). Bounded; a page load fits comfortably.
 */
interface WaterfallEntry {
  relay: string;
  shape: string;
  sentAt: number;
  firstEventAt?: number;
  eoseAt?: number;
  closedAt?: number;
  cancelledAt?: number;
  events: number;
}
const WATERFALL_MAX = 4000;
const waterfall: WaterfallEntry[] = [];
const openWaterfall = new WeakMap<WebSocket, Map<string, WaterfallEntry>>();
/** Socket dials: when each connection was opened and when it connected. */
const dials: {
  relay: string;
  dialAt: number;
  openAt?: number;
  closeAt?: number;
}[] = [];

function waterfallOf(ws: WebSocket): Map<string, WaterfallEntry> {
  let m = openWaterfall.get(ws);
  if (!m) {
    m = new Map();
    openWaterfall.set(ws, m);
  }
  return m;
}

function dropSub(ws: WebSocket, stats: RelayStats, sub: string): void {
  if (subsOf(ws).delete(sub)) stats.liveSubs = Math.max(0, stats.liveSubs - 1);
}

function onOutbound(ws: WebSocket, data: unknown): void {
  const key = socketKeys.get(ws);
  if (!key || typeof data !== "string") return;
  const stats = relayStats(key);
  const head = frameHead(data);
  if (!head) return;
  switch (head.verb) {
    case "REQ": {
      stats.reqs += 1;
      let shape = "?";
      try {
        shape = filterShape((JSON.parse(data) as unknown[]).slice(2));
      } catch {
        // malformed REQ: counted under "?"
      }
      shapeAgg(shape).reqs += 1;
      if (head.sub !== undefined) {
        const subs = subsOf(ws);
        if (!subs.has(head.sub)) {
          stats.liveSubs += 1;
          if (stats.liveSubs > stats.peakSubs) stats.peakSubs = stats.liveSubs;
        }
        subs.set(head.sub, shape);
        if (waterfall.length < WATERFALL_MAX) {
          const entry = { relay: key, shape, sentAt: now(), events: 0 };
          waterfall.push(entry);
          waterfallOf(ws).set(head.sub, entry);
        }
      }
      break;
    }
    case "CLOSE":
      stats.closes += 1;
      if (head.sub !== undefined) {
        dropSub(ws, stats, head.sub);
        const entry = waterfallOf(ws).get(head.sub);
        if (entry) entry.cancelledAt ??= now();
        waterfallOf(ws).delete(head.sub);
      }
      break;
    case "EVENT":
      stats.publishes += 1;
      break;
    case "AUTH":
      stats.auths += 1;
      break;
  }
}

function onInbound(ws: WebSocket, data: unknown): void {
  const key = socketKeys.get(ws);
  if (!key || typeof data !== "string") return;
  const stats = relayStats(key);
  stats.textCharsIn += data.length;
  const head = frameHead(data);
  if (!head) return;
  switch (head.verb) {
    case "EVENT": {
      stats.events += 1;
      const m = /"kind"\s*:\s*(\d+)/.exec(data);
      if (m) {
        const kind = Number(m[1]);
        let k = state.eventsByKind.get(kind);
        if (!k) {
          k = { count: 0, textChars: 0 };
          state.eventsByKind.set(kind, k);
        }
        k.count += 1;
        k.textChars += data.length;
      }
      const shape =
        head.sub !== undefined ? subsOf(ws).get(head.sub) : undefined;
      if (shape !== undefined) {
        const a = shapeAgg(shape);
        a.events += 1;
        a.textChars += data.length;
      }
      const entry =
        head.sub !== undefined ? waterfallOf(ws).get(head.sub) : undefined;
      if (entry) {
        entry.events += 1;
        entry.firstEventAt ??= now();
      }
      break;
    }
    case "EOSE": {
      stats.eose += 1;
      const shape =
        head.sub !== undefined ? subsOf(ws).get(head.sub) : undefined;
      if (shape !== undefined) shapeAgg(shape).eose += 1;
      const entry =
        head.sub !== undefined ? waterfallOf(ws).get(head.sub) : undefined;
      if (entry) entry.eoseAt ??= now();
      break;
    }
    case "CLOSED": {
      stats.closed += 1;
      if (head.sub !== undefined) dropSub(ws, stats, head.sub);
      const entry =
        head.sub !== undefined ? waterfallOf(ws).get(head.sub) : undefined;
      if (entry) entry.closedAt ??= now();
      break;
    }
    case "NOTICE":
      stats.notices += 1;
      break;
  }
}

function socketKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

function installWebSocketProbe(): void {
  if (typeof WebSocket === "undefined") return;
  const Native = WebSocket;
  const nativeSend = Native.prototype.send;
  Native.prototype.send = function (
    this: WebSocket,
    data: Parameters<WebSocket["send"]>[0],
  ) {
    try {
      onOutbound(this, data);
    } catch {
      // the instrument must never break a send
    }
    return nativeSend.call(this, data);
  };

  class ProfiledWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const key = socketKey(String(url));
      socketKeys.set(this, key);
      const stats = relayStats(key);
      stats.opened += 1;
      const dial: (typeof dials)[number] = { relay: key, dialAt: now() };
      if (dials.length < WATERFALL_MAX) dials.push(dial);
      let isOpen = false;
      this.addEventListener("open", () => {
        isOpen = true;
        stats.open += 1;
        dial.openAt = now();
      });
      this.addEventListener("message", (ev) => {
        try {
          onInbound(this, (ev as MessageEvent).data);
        } catch {
          // never break a receive
        }
      });
      this.addEventListener("close", () => {
        dial.closeAt ??= now();
        const subs = socketSubs.get(this);
        if (subs) {
          stats.liveSubs = Math.max(0, stats.liveSubs - subs.size);
          socketSubs.delete(this);
        }
        if (isOpen) {
          isOpen = false;
          stats.open = Math.max(0, stats.open - 1);
        }
      });
    }
  }
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    ProfiledWebSocket;
}

/** 1 in SAMPLE_EVERY setTimeout/rAF calls captures a stack. */
const SAMPLE_EVERY = 32;

const liveIntervals = new Map<
  number,
  { site: string; ms: number; fires: number }
>();

function installTimerProbe(): void {
  const w = window as unknown as Record<string, unknown>;
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;
  const nativeSetInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  const nativeRaf = window.requestAnimationFrame;

  w.setTimeout = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) {
    state.timeoutCalls += 1;
    if (state.timeoutCalls % SAMPLE_EVERY === 0) {
      const site = callSite(new Error().stack);
      state.timeoutSites.set(site, (state.timeoutSites.get(site) ?? 0) + 1);
    }
    return nativeSetTimeout.call(window, handler, timeout, ...args);
  };

  w.setInterval = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) {
    const rec = {
      site: callSite(new Error().stack),
      ms: Number(timeout) || 0,
      fires: 0,
    };
    const wrapped: TimerHandler =
      typeof handler === "function"
        ? function (this: unknown, ...a: unknown[]) {
            rec.fires += 1;
            return (handler as (...x: unknown[]) => unknown).apply(this, a);
          }
        : handler;
    const id = nativeSetInterval.call(window, wrapped, timeout, ...args);
    liveIntervals.set(id, rec);
    return id;
  };

  w.clearInterval = function (id?: number) {
    if (id !== undefined) liveIntervals.delete(id);
    return nativeClearInterval.call(window, id);
  };
  w.clearTimeout = function (id?: number) {
    if (id !== undefined) liveIntervals.delete(id);
    return nativeClearTimeout.call(window, id);
  };

  w.requestAnimationFrame = function (cb: FrameRequestCallback) {
    state.rafCalls += 1;
    if (state.rafCalls % SAMPLE_EVERY === 0) {
      const site = callSite(new Error().stack);
      state.rafSites.set(site, (state.rafSites.get(site) ?? 0) + 1);
    }
    return nativeRaf.call(window, cb);
  };
}

/** The slice of a React Fiber this reads. Internal, but stable since 16. */
interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  actualDuration?: number;
  selfBaseDuration?: number;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  dependencies?: { firstContext: ContextDependency | null } | null;
}

interface HookNode {
  memoizedState: unknown;
  queue: unknown;
  next: HookNode | null;
}

interface ContextDependency {
  context: { displayName?: string };
  memoizedValue: unknown;
  next: ContextDependency | null;
}

const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const SIMPLE_MEMO_COMPONENT = 15;
/** `PerformedWork`: the component's render function actually ran this commit. */
const PERFORMED_WORK = 1;

let renderTracking = false;

function nameOf(t: unknown): string | undefined {
  if (!t || (typeof t !== "function" && typeof t !== "object"))
    return undefined;
  const r = t as { displayName?: string; name?: string };
  return r.displayName || r.name || undefined;
}

function fiberName(f: Fiber): string | undefined {
  switch (f.tag) {
    case FUNCTION_COMPONENT:
    case CLASS_COMPONENT:
    case SIMPLE_MEMO_COMPONENT:
      return nameOf(f.type) ?? "Anonymous";
    case FORWARD_REF: {
      const t = f.type as { displayName?: string; render?: unknown } | null;
      return t?.displayName || nameOf(t?.render) || "ForwardRef";
    }
    default:
      return undefined;
  }
}

function changedProps(prev: unknown, next: unknown): string[] {
  if (
    prev === next ||
    !prev ||
    !next ||
    typeof prev !== "object" ||
    typeof next !== "object"
  ) {
    return prev === next ? [] : ["(props)"];
  }
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== "children" && !Object.is(a[key], b[key])) changed.push(key);
  }
  if (changed.length === 0 && !Object.is(a.children, b.children)) {
    changed.push("children");
  }
  return changed;
}

/** Contexts and stateful hooks whose values changed, by position. */
function changedHooks(prev: Fiber, next: Fiber): string[] {
  const out: string[] = [];
  let a = prev.dependencies?.firstContext ?? null;
  let b = next.dependencies?.firstContext ?? null;
  while (a && b) {
    if (
      a.context === b.context &&
      !Object.is(a.memoizedValue, b.memoizedValue)
    ) {
      out.push(`ctx:${b.context.displayName ?? "?"}`);
    }
    a = a.next;
    b = b.next;
  }
  if (next.tag === CLASS_COMPONENT) return out;
  let h = prev.memoizedState as HookNode | null | undefined;
  let k = next.memoizedState as HookNode | null | undefined;
  let n = 0;
  while (
    h &&
    k &&
    typeof h === "object" &&
    typeof k === "object" &&
    "next" in k
  ) {
    if (k.queue !== null && k.queue !== undefined) {
      if (!Object.is(h.memoizedState, k.memoizedState)) out.push(`state#${n}`);
      n += 1;
    }
    h = h.next;
    k = k.next;
  }
  return out;
}

function renderCause(prev: Fiber, next: Fiber): string[] {
  const props = changedProps(prev.memoizedProps, next.memoizedProps);
  if (props.length > 0) return props;
  const hooks = changedHooks(prev, next);
  if (hooks.length > 0) return hooks;
  return [prev.memoizedProps === next.memoizedProps ? "(unknown)" : "(parent)"];
}

function walkCommit(rootFiber: Fiber | null): void {
  const stack: Fiber[] = [];
  if (rootFiber) stack.push(rootFiber);
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (f.sibling) stack.push(f.sibling);
    const mount = f.alternate === null;
    if (mount || (f.flags & PERFORMED_WORK) !== 0) {
      const name = fiberName(f);
      if (name) {
        let r = state.renders.get(name);
        if (!r) {
          r = { renders: 0, mounts: 0, selfMs: 0, why: new Map() };
          state.renders.set(name, r);
        }
        if (mount) r.mounts += 1;
        else {
          r.renders += 1;
          for (const key of renderCause(f.alternate!, f)) {
            r.why.set(key, (r.why.get(key) ?? 0) + 1);
          }
        }
        if (typeof f.selfBaseDuration === "number") {
          r.selfMs += f.selfBaseDuration;
        }
      }
    }
    if (f.child && (mount || f.child !== f.alternate!.child)) {
      stack.push(f.child);
    }
  }
}

function installReactHook(): void {
  const w = window as unknown as {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown>;
  };
  let hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    // No DevTools hook (headless): provide the one react-dom looks for.
    let nextId = 1;
    hook = {
      renderers: new Map(),
      supportsFiber: true,
      inject: () => nextId++,
      onCommitFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      setStrictMode: () => {},
      checkDCE: () => {},
    };
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }
  const prev = hook.onCommitFiberRoot as
    | ((...a: unknown[]) => unknown)
    | undefined;
  hook.onCommitFiberRoot = function (
    this: unknown,
    id: unknown,
    root: { current: Fiber },
    ...rest: unknown[]
  ) {
    try {
      state.commits += 1;
      const d = root.current.actualDuration;
      if (typeof d === "number") state.commitMs += d;
      if (renderTracking) walkCommit(root.current.child);
    } catch {
      // React internals aren't API; a shape change costs the report, never the commit.
    }
    return prev?.call(this, id, root, ...rest);
  };
}

/** The slice of an applesauce EventStore this reads. */
interface StoreLike {
  insert$: { subscribe(fn: (e: { kind: number }) => void): unknown };
  update$: { subscribe(fn: () => void): unknown };
  remove$: { subscribe(fn: () => void): unknown };
}

/** Count EventStore inserts by kind, updates and removes. */
export function instrumentEventStore(store: StoreLike): void {
  store.insert$.subscribe((e) => {
    state.storeInserts.set(e.kind, (state.storeInserts.get(e.kind) ?? 0) + 1);
  });
  store.update$.subscribe(() => {
    state.storeUpdates += 1;
  });
  store.remove$.subscribe(() => {
    state.storeRemoves += 1;
  });
}

/**
 * Time every IndexedDB cache query by filter shape: wall time from request to
 * results, which is what a loader waits on before it goes to relays.
 */
export function instrumentCacheQuery<F extends unknown[], R extends unknown[]>(
  query: (filters: F) => Promise<R>,
): (filters: F) => Promise<R> {
  return async (filters) => {
    const t0 = now();
    const out = await query(filters);
    const shape = filterShape(filters);
    let a = state.cacheQueries.get(shape);
    if (!a) {
      a = { count: 0, total: 0, max: 0, layout: 0, events: 0 };
      state.cacheQueries.set(shape, a);
    }
    const ms = now() - t0;
    a.count += 1;
    a.total += ms;
    if (ms > a.max) a.max = ms;
    a.events += out.length;
    return out;
  };
}

const SAMPLE_MS = 10_000;
const MAX_SAMPLES = 360;

interface Sample {
  t: number;
  heapMB?: number;
  domNodes: number;
  sockets: number;
  liveSubs: number;
  intervals: number;
}

const samples: Sample[] = [];

function heapMB(): number | undefined {
  const mem = (
    performance as unknown as { memory?: { usedJSHeapSize: number } }
  ).memory;
  return mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : undefined;
}

function takeSample(): void {
  let sockets = 0;
  let liveSubs = 0;
  for (const s of relays.values()) {
    sockets += s.open;
    liveSubs += s.liveSubs;
  }
  samples.push({
    t: Math.round(now() / 1000),
    heapMB: heapMB(),
    domNodes: document.getElementsByTagName("*").length,
    sockets,
    liveSubs,
    intervals: liveIntervals.size,
  });
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function top<T>(entries: T[], by: (t: T) => number, n: number): T[] {
  return entries.sort((a, b) => by(b) - by(a)).slice(0, n);
}

export function runtimeReport() {
  const windowMs = Math.max(1, now() - state.windowStart);
  const perSec = (n: number) => r1(n / (windowMs / 1000));
  return {
    windowSec: Math.round(windowMs / 1000),
    frames: {
      api: state.frameApi,
      count: state.frames.count,
      totalMs: Math.round(state.frames.total),
      blockingMs: Math.round(state.frames.blocking),
      maxMs: Math.round(state.frames.max),
      forcedLayoutMs: Math.round(state.frames.layout),
      longFrameWallPct: r1((state.frames.total / windowMs) * 100),
      scripts: top(
        [...state.scripts.entries()].map(([site, a]) => ({
          site,
          count: a.count,
          totalMs: Math.round(a.total),
          maxMs: Math.round(a.max),
          layoutMs: Math.round(a.layout),
        })),
        (s) => s.totalMs,
        40,
      ),
    },
    react: {
      commits: state.commits,
      commitsPerMin: r1(state.commits / (windowMs / 60000)),
      ...(state.commitMs > 0 ? { commitMs: Math.round(state.commitMs) } : {}),
      renderTracking,
      components: top(
        [...state.renders.entries()].map(([name, r]) => ({
          name,
          renders: r.renders,
          mounts: r.mounts,
          estimatedBaseMs: r1(r.selfMs),
          why: [...r.why.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 4)
            .map(([k, n]) => `${k}×${n}`)
            .join(" "),
        })),
        (c) =>
          c.estimatedBaseMs > 0 ? c.estimatedBaseMs : c.renders + c.mounts,
        80,
      ),
    },
    timers: {
      setTimeoutPerSec: perSec(state.timeoutCalls),
      rafPerSec: perSec(state.rafCalls),
      liveIntervals: top(
        [...liveIntervals.values()].map((i) => ({ ...i })),
        (i) => i.fires,
        40,
      ),
      timeoutSites: top(
        [...state.timeoutSites.entries()].map(([site, n]) => ({
          site,
          estCalls: n * SAMPLE_EVERY,
        })),
        (s) => s.estCalls,
        30,
      ),
      rafSites: top(
        [...state.rafSites.entries()].map(([site, n]) => ({
          site,
          estCalls: n * SAMPLE_EVERY,
        })),
        (s) => s.estCalls,
        15,
      ),
    },
    relays: top(
      [...relays.entries()].map(([url, s]) => ({ url, ...s })),
      (r) => r.reqs * 1000 + r.events,
      80,
    ),
    eventsByKind: top(
      [...state.eventsByKind.entries()].map(([kind, k]) => ({ kind, ...k })),
      (k) => k.count,
      40,
    ),
    store: {
      inserts: top(
        [...state.storeInserts.entries()].map(([kind, count]) => ({
          kind,
          count,
        })),
        (k) => k.count,
        40,
      ),
      updates: state.storeUpdates,
      removes: state.storeRemoves,
    },
    cacheQueries: top(
      [...state.cacheQueries.entries()].map(([shape, a]) => ({
        shape,
        count: a.count,
        totalMs: Math.round(a.total),
        maxMs: Math.round(a.max),
        events: a.events,
      })),
      (q) => q.totalMs,
      30,
    ),
    reqShapes: top(
      [...state.shapes.entries()].map(([shape, a]) => ({ shape, ...a })),
      (a) => a.reqs * 1000 + a.events,
      60,
    ),
    samples: samples.map((s) => ({ ...s })),
  };
}

/**
 * Every REQ since page load with its first-event and EOSE times, and every
 * socket dial with its connect time (ms since navigation start). Not reset by
 * `reset()`: it is the load's timeline.
 */
export function waterfallReport() {
  const ms = (t: number | undefined) =>
    t === undefined ? undefined : Math.round(t);
  return {
    reqs: waterfall.map((e) => ({
      relay: e.relay,
      shape: e.shape,
      sentAt: ms(e.sentAt),
      firstEventAt: ms(e.firstEventAt),
      eoseAt: ms(e.eoseAt),
      closedAt: ms(e.closedAt),
      cancelledAt: ms(e.cancelledAt),
      events: e.events,
    })),
    dials: dials.map((d) => ({
      relay: d.relay,
      dialAt: ms(d.dialAt),
      openAt: ms(d.openAt),
      closeAt: ms(d.closeAt),
    })),
  };
}

let installed = false;

/** Install every probe (idempotent). See `perfRuntimeInstall.ts`. */
export function installRuntimeProfiler(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      // an unsupported probe is a gap in the report, not a crash
    }
  };
  guard(installFrameObserver);
  guard(installWebSocketProbe);
  guard(installTimerProbe);
  guard(installReactHook);
  window.setInterval(takeSample, SAMPLE_MS);

  (window as unknown as { __gwPerf: Record<string, unknown> }).__gwPerf = {
    report: runtimeReport,
    json: () =>
      JSON.stringify(
        {
          schemaVersion: 1,
          page: location.pathname,
          visibility: document.visibilityState,
          reactProfilingBuild: import.meta.env.VITE_PROFILE_REACT === "1",
          waterfall: waterfallReport(),
          generatedAt: new Date().toISOString(),
          commit: __GIT_COMMIT__,
          userAgent: navigator.userAgent,
          cores: navigator.hardwareConcurrency,
          runtime: runtimeReport(),
        },
        null,
        2,
      ),
    reset: resetWindow,
    waterfall: waterfallReport,
    renders: (on = true) => {
      renderTracking = on;
      return on;
    },
  };
}
