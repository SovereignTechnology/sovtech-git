/*
The MIT License (MIT)

Copyright (c) 2024 hzrd149

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


Compatibility extraction from applesauce-loaders 6.2.0.
Retains v6 cursor semantics; does not opt into v7 window or sync policies.
*/
import { mergeFilters } from "applesauce-core/helpers/filter";
import { filter, finalize, merge, mergeMap, tap } from "rxjs";
import { wrapUpstreamPool } from "applesauce-loaders/helpers";
import type { Debugger } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import type { Observable, OperatorFunction } from "rxjs";
import type { TimelessFilter, UpstreamPool } from "applesauce-loaders";
type TimelineWindow = { since?: number; until?: number };
type CommonTimelineLoaderOptions = { limit?: number; logger?: Debugger };

export function loadBackwardBlocks(
  request: (until?: number) => Observable<NostrEvent>,
  opts?: CommonTimelineLoaderOptions,
): OperatorFunction<TimelineWindow, NostrEvent> {
  return (source) => {
    const log = opts?.logger?.extend("backward");
    let cursor: number | undefined;
    let loading = false;
    let complete = false;
    return source.pipe(
      filter(({ since, until }) => {
        // Once complete, prevent further requests
        if (complete) return false;
        // If max is unset, initialize to until
        if (
          cursor === undefined &&
          until !== undefined &&
          Number.isFinite(until)
        )
          cursor = until;
        // Skip loads if since is still in range
        if (
          // Ignore undefined since values
          since === undefined ||
          // If number is finite and in the loaded range, skip
          (Number.isFinite(since) && cursor !== undefined && since <= cursor)
        )
          return false;
        // Don't load blocks in parallel
        if (loading) return false;
        return true;
      }),
      // NOTE: use mergeMap here to ensure old requests continue to load
      mergeMap(() => {
        // Set loading lock
        loading = true;
        // Count returned events so complete set
        let count = 0;
        let minCreatedAt: number | undefined;
        const until = cursor;
        log?.(`Loading block since:${cursor}`);
        // Request the next block of events
        return request(until).pipe(
          tap((event) => {
            count++;
            minCreatedAt = Math.min(event.created_at, minCreatedAt ?? Infinity);
          }),
          finalize(() => {
            // NIP-01 defines `until` as inclusive. Move past the oldest event in
            // the block so the next request does not repeat the boundary second.
            if (minCreatedAt !== undefined) {
              const next = minCreatedAt - 1;
              // Stop if the relay ignores `until` and stops making backward progress.
              if (until !== undefined && next >= until) complete = true;
              else cursor = next;
            }
            loading = false;
            complete = complete || count === 0;
            log?.(`Found ${count} events`);
            if (complete) log?.("Complete");
          }),
        );
      }),
    );
  };
}

function loadForwardBlocks(
  request: (since?: number) => Observable<NostrEvent>,
  opts?: CommonTimelineLoaderOptions,
): OperatorFunction<TimelineWindow, NostrEvent> {
  return (source) => {
    const log = opts?.logger?.extend("forward");
    let cursor: number | undefined;
    let loading = false;
    let complete = false;
    return source.pipe(
      filter(({ since, until }) => {
        // Once complete, prevent further requests
        if (complete) return false;
        // If min is unset, initialize to since
        if (
          cursor === undefined &&
          since !== undefined &&
          Number.isFinite(since)
        )
          cursor = since;
        // Skip loads if until is still in range
        if (
          // Ignore undefined until values
          until === undefined ||
          // If number is finite and in the loaded range, skip
          (Number.isFinite(until) && cursor !== undefined && until <= cursor)
        )
          return false;
        // Don't load blocks in parallel
        if (loading) return false;
        return true;
      }),
      // NOTE: use mergeMap here to ensure old requests continue to load
      mergeMap(() => {
        // Set loading lock
        loading = true;
        // Count returned events so complete set
        let count = 0;
        let maxCreatedAt: number | undefined;
        const since = cursor;
        log?.(`Loading block since:${since}`);
        // Request the next block of events
        return request(since).pipe(
          tap((event) => {
            count++;
            maxCreatedAt = Math.max(
              event.created_at,
              maxCreatedAt ?? -Infinity,
            );
          }),
          finalize(() => {
            if (maxCreatedAt !== undefined) {
              // Stop if the source ignores `since` and stops making forward progress.
              if (since !== undefined && maxCreatedAt <= since) complete = true;
              else cursor = maxCreatedAt;
            }
            loading = false;
            complete = complete || count === 0;
            log?.(`Found ${count} events`);
            if (complete) log?.("Complete");
          }),
        );
      }),
    );
  };
}

function loadBlocksForTimelineWindow(
  request: (base: Filter) => Observable<NostrEvent>,
  opts?: CommonTimelineLoaderOptions,
): OperatorFunction<TimelineWindow, NostrEvent> {
  return (source) =>
    merge(
      source.pipe(loadBackwardBlocks((until) => request({ until }), opts)),
      source.pipe(loadForwardBlocks((since) => request({ since }), opts)),
    );
}

export function loadBlocksFromRelay(
  pool: UpstreamPool,
  relay: string,
  filters: TimelessFilter[] | TimelessFilter,
  opts?: CommonTimelineLoaderOptions,
): OperatorFunction<TimelineWindow, NostrEvent> {
  if (!Array.isArray(filters)) filters = [filters];
  const logger = opts?.logger?.extend(relay);
  const request = wrapUpstreamPool(pool);
  const loader = (base: Filter) =>
    request(
      [relay],
      // Create filters from filters, base, and optional limit
      filters.map((f) =>
        opts?.limit
          ? mergeFilters(f, base, { limit: opts.limit })
          : mergeFilters(f, base),
      ),
    );
  return (source) =>
    source.pipe(loadBlocksForTimelineWindow(loader, { ...opts, logger }));
}
