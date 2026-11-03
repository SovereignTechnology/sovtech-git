import type { Relay, RelayPool } from "applesauce-relay";
import { Subscription } from "rxjs";

export interface PreloadTask {
  load: () => Promise<unknown>;
  isLoaded: () => boolean;
}

let activeImports = 0;
let noteActivity: (() => void) | undefined;

/** Share foreground and speculative imports, without retaining failed attempts. */
export function deferredModule<T>(importModule: () => Promise<T>) {
  let promise: Promise<T> | undefined;
  let loaded = false;
  return {
    isLoaded: () => loaded,
    load: () => {
      if (promise) return promise;
      activeImports++;
      noteActivity?.();
      promise = importModule()
        .then(
          (module) => {
            loaded = true;
            return module;
          },
          (error: unknown) => {
            promise = undefined;
            throw error;
          },
        )
        .finally(() => {
          activeImports--;
          noteActivity?.();
        });
      return promise;
    },
  };
}

const queue = new Set<PreloadTask>();
let wake: (() => void) | undefined;

/** Intent changes order, never bypasses the foreground-activity gate. */
export function queuePreload(task: PreloadTask, priority = false) {
  if (task.isLoaded()) return;
  if (priority) {
    const rest = [...queue];
    queue.clear();
    queue.add(task);
    for (const pending of rest) queue.add(pending);
  } else queue.add(task);
  wake?.();
}

/**
 * Opportunistic admission, not a network-idle or data-completeness guarantee.
 * Live sockets may stay open forever. Wait for outstanding REQ snapshots and
 * a quiet interval instead. One import at a time limits speculative overlap;
 * a started import cannot be cancelled when foreground work resumes.
 */
export function startBackgroundPreloads(pool: RelayPool): () => void {
  const quietMs = 1500;
  let lastActivity = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let running = false;
  let stopped = false;
  const subscriptions = new Subscription();
  const relays = new Map<
    Relay,
    { settled: Map<string, unknown>; sub: Subscription }
  >();
  const activity = () => {
    lastActivity = performance.now();
  };

  const watchRelay = (relay: Relay) => {
    if (relays.has(relay)) return;
    const settled = new Map<string, unknown>();
    const sub = new Subscription();
    // Both streams are passive: observing them never opens a connection.
    sub.add(
      relay.message$.subscribe((message: unknown) => {
        activity();
        if (Array.isArray(message) && typeof message[1] === "string") {
          if (message[0] === "EOSE")
            settled.set(message[1], relay.reqs$.get(message[1]));
          else if (message[0] === "CLOSED") settled.delete(message[1]);
        }
      }),
    );
    sub.add(
      relay.close$.subscribe(() => {
        settled.clear();
        activity();
      }),
    );
    relays.set(relay, { settled, sub });
  };
  for (const relay of pool.relays.values()) watchRelay(relay);
  subscriptions.add(pool.add$.subscribe(watchRelay));
  subscriptions.add(
    pool.remove$.subscribe((relay) => {
      relays.get(relay)?.sub.unsubscribe();
      relays.delete(relay);
    }),
  );

  // Read REQ inventories only when considering a preload. Subscribing to
  // reqs$ would make every REQ mutation copy its entire filter inventory.
  const hasPendingSnapshots = () => {
    let pending = false;
    for (const [relay, { settled }] of relays) {
      const requests = relay.reqs$.getValue();
      for (const id of settled.keys())
        if (!(id in requests)) settled.delete(id);
      if (Object.keys(requests).some((id) => settled.get(id) !== requests[id]))
        pending = true;
    }
    return pending;
  };

  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  const allowed = () =>
    document.readyState === "complete" &&
    document.visibilityState === "visible" &&
    navigator.onLine &&
    activeImports === 0 &&
    !connection?.saveData &&
    !["slow-2g", "2g"].includes(connection?.effectiveType ?? "") &&
    performance.now() - lastActivity >= quietMs &&
    !hasPendingSnapshots();

  function schedule() {
    if (stopped || running || timer !== undefined || idle !== undefined) return;
    for (const task of queue) if (task.isLoaded()) queue.delete(task);
    if (queue.size === 0) return;
    timer = setTimeout(check, quietMs);
  }

  function check() {
    timer = undefined;
    if (!allowed()) {
      schedule();
      return;
    }
    // No timeout forcing work through a busy main thread. Without this API,
    // use the quiet-period timer and reject callbacks delayed by a long task.
    if ("requestIdleCallback" in window) {
      idle = window.requestIdleCallback((deadline) => {
        idle = undefined;
        if (deadline.timeRemaining() >= 10) run();
        else schedule();
      });
    } else {
      const scheduledAt = performance.now();
      timer = setTimeout(() => {
        timer = undefined;
        if (performance.now() - scheduledAt < 100) run();
        else {
          activity();
          schedule();
        }
      }, 0);
    }
  }

  function run() {
    // Traffic/interaction may have resumed while waiting for the idle slot.
    if (stopped || !allowed()) {
      schedule();
      return;
    }
    const task = queue.values().next().value;
    if (!task) return;
    queue.delete(task);
    running = true;
    void task
      .load()
      .catch(() => {
        // Speculation must not produce an unhandled rejection. Foreground
        // navigation uses the same loader and can retry a failed attempt.
      })
      .finally(() => {
        running = false;
        activity();
        schedule();
      });
  }

  const events = ["pointerdown", "keydown", "scroll", "focusin"] as const;
  for (const event of events)
    document.addEventListener(event, activity, {
      passive: true,
      capture: true,
    });
  document.addEventListener("visibilitychange", activity);
  window.addEventListener("online", activity);
  window.addEventListener("load", activity);
  const observer =
    typeof PerformanceObserver !== "undefined"
      ? new PerformanceObserver(activity)
      : undefined;
  const entryTypes = ["longtask", "resource"].filter(
    (type) =>
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes(type),
  );
  if (entryTypes.length) observer?.observe({ entryTypes });
  noteActivity = activity;
  wake = schedule;
  schedule();
  return () => {
    stopped = true;
    wake = undefined;
    noteActivity = undefined;
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    subscriptions.unsubscribe();
    for (const { sub } of relays.values()) sub.unsubscribe();
    observer?.disconnect();
    for (const event of events)
      document.removeEventListener(event, activity, true);
    document.removeEventListener("visibilitychange", activity);
    window.removeEventListener("online", activity);
    window.removeEventListener("load", activity);
  };
}
