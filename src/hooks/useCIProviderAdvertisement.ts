import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { EMPTY, of, timer } from "rxjs";
import { expand, map, scan, switchMap } from "rxjs/operators";
import {
  CIProviderAdvertisement,
  isValidCIProviderAdvertisement,
  retainProviderAdvertisements,
} from "@/casts/CIProvider";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import {
  CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
  CI_LEGACY_PROVIDER_ADVERTISEMENT_KIND,
} from "@/lib/ci";
import { ciIdentityEnrichment$ } from "@/services/ciQueries";

export interface CIProviderAdvertisements {
  advertisements: CIProviderAdvertisement[];
  now: number;
}

export interface CIProviderAdvertisementState extends CIProviderAdvertisements {
  settled: boolean;
  partial: boolean;
}

/** Discover every offering from this provider through the shared identity query. */
export function useCIProviderAdvertisement(
  pubkey: string | undefined,
  relayHints: readonly string[] = [],
): CIProviderAdvertisementState {
  const relayHintKey = JSON.stringify([...relayHints].sort());
  const query = use$(() => {
    if (!pubkey)
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    return ciIdentityEnrichment$(pubkey, relayHints);
  }, [pubkey, relayHintKey]);
  const offerings = useStoredCIProviderAdvertisements(pubkey);
  return {
    ...offerings,
    settled: query?.settled === true,
    partial:
      (query?.failedRelayCount ?? 0) > 0 ||
      (query?.settled === true && (query.relayCount ?? 0) === 0),
  };
}

/** Store-only reader. Each address replaces independently; observed expirations survive this visit. */
export function useStoredCIProviderAdvertisements(
  pubkey: string | undefined,
): CIProviderAdvertisements {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  return (
    use$(() => {
      if (!pubkey)
        return of({ advertisements: [], now: Math.floor(Date.now() / 1000) });
      return store
        .timeline([
          {
            kinds: [
              CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
              CI_LEGACY_PROVIDER_ADVERTISEMENT_KIND,
            ],
            authors: [pubkey],
          } as Filter,
        ])
        .pipe(
          scan(
            (previous: NostrEvent[], events) =>
              retainProviderAdvertisements(
                previous,
                events,
                Math.floor(Date.now() / 1000),
              ),
            [],
          ),
          map((events) =>
            events
              .filter(isValidCIProviderAdvertisement)
              .map((event) => new CIProviderAdvertisement(event, castStore))
              .sort(
                (a, b) =>
                  Number(a.isLegacy) - Number(b.isLegacy) ||
                  (a.offeringId ?? "").localeCompare(b.offeringId ?? ""),
              ),
          ),
          switchMap((advertisements) =>
            of(Math.floor(Date.now() / 1000)).pipe(
              // One deadline at a time, cancelled on replacement or unmount. Also
              // recheck when a future-dated advertisement reaches its start time.
              expand((now) => {
                const next = Math.min(
                  ...advertisements
                    .flatMap((ad) => [ad.event.created_at, ad.expiration])
                    .filter((time) => time > now),
                );
                return Number.isFinite(next)
                  ? timer(
                      // Browser timers overflow beyond a signed 32-bit delay.
                      Math.min(
                        2_147_483_647,
                        Math.max(1, next * 1000 - Date.now()),
                      ),
                    ).pipe(map(() => Math.floor(Date.now() / 1000)))
                  : EMPTY;
              }),
              map((now) => ({ advertisements, now })),
            ),
          ),
        );
    }, [pubkey, store]) ?? {
      advertisements: [],
      now: Math.floor(Date.now() / 1000),
    }
  );
}
