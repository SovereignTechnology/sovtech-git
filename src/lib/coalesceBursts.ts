import { asyncScheduler, type MonoTypeOperatorFunction } from "rxjs";
import { throttleTime } from "rxjs/operators";

/** Preserve the first and latest snapshots while bounding expensive list rebuilds. */
export function coalesceBursts<T>(ms = 100): MonoTypeOperatorFunction<T> {
  return throttleTime(ms, asyncScheduler, { leading: true, trailing: true });
}
