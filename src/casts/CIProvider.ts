import { EventCast } from "applesauce-common/casts/cast";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { getOrComputeCachedValue } from "applesauce-core/helpers";
import type { KnownEvent } from "applesauce-core/helpers/event";
import type { NostrEvent } from "nostr-tools";
import {
  CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
  CI_LEGACY_PROVIDER_ADVERTISEMENT_KIND,
} from "@/lib/ci";
import { normalizeUrl } from "@/lib/url";

type CIProviderAdvertisementEvent = KnownEvent<
  | typeof CI_NIX_PROVIDER_ADVERTISEMENT_KIND
  | typeof CI_LEGACY_PROVIDER_ADVERTISEMENT_KIND
>;

const DetailsSymbol = Symbol.for("ci-provider-offering-details");

export type CIProviderIsolation = "hardware-vm" | "weak-container" | "direct";

interface ProviderDetails {
  expiration: number;
  runnerFamilies: string[];
  runnerSelectors: string[];
  offeringId?: string;
  isolation?: CIProviderIsolation;
  capacity?: { total: number; available: number };
  allocationInbox?: { pubkey: string; relays: string[] };
  environment?: { hash: string; url: string };
}

function tagsNamed(event: NostrEvent, name: string): string[][] {
  return event.tags.filter(([tag]) => tag === name);
}

function integer(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function expiration(event: NostrEvent): number | undefined {
  const tags = tagsNamed(event, "expiration");
  const value = integer(tags[0]?.[1]);
  return tags.length === 1 &&
    tags[0].length === 2 &&
    value !== undefined &&
    value > event.created_at &&
    value <= event.created_at + 1800
    ? value
    : undefined;
}

/** Decode the old singleton shape without treating it as a native offering. */
function legacyDetails(event: NostrEvent): ProviderDetails | undefined {
  if (
    event.kind !== CI_LEGACY_PROVIDER_ADVERTISEMENT_KIND ||
    event.content !== ""
  )
    return undefined;
  const expires = expiration(event);
  const values = (name: string) => [
    ...new Set(
      tagsNamed(event, name)
        .map((tag) => tag[1]?.toLowerCase())
        .filter((value): value is string => !!value),
    ),
  ];
  const runnerFamilies = values("W");
  const runnerSelectors = values("R");
  return expires !== undefined &&
    runnerFamilies.length &&
    runnerSelectors.length
    ? { expiration: expires, runnerFamilies, runnerSelectors }
    : undefined;
}

/** Validate consumed offering fields; this is not an allocation authorization check. */
function offeringDetails(event: NostrEvent): ProviderDetails | undefined {
  if (event.kind !== CI_NIX_PROVIDER_ADVERTISEMENT_KIND || event.content !== "")
    return undefined;
  const expires = expiration(event);
  const ids = tagsNamed(event, "d");
  const isolation = tagsNamed(event, "isolation");
  const capacities = tagsNamed(event, "capacity");
  const inboxes = tagsNamed(event, "allocation-key");
  const total = integer(capacities[0]?.[1]);
  const available = integer(capacities[0]?.[2]);
  const boundary = isolation[0]?.[1];
  if (
    expires === undefined ||
    ids.length !== 1 ||
    ids[0].length !== 2 ||
    !ids[0][1] ||
    isolation.length !== 1 ||
    isolation[0].length !== 2 ||
    (boundary !== "hardware-vm" &&
      boundary !== "weak-container" &&
      boundary !== "direct") ||
    capacities.length !== 1 ||
    capacities[0].length !== 3 ||
    total === undefined ||
    total === 0 ||
    available === undefined ||
    available > total ||
    inboxes.length !== 1
  )
    return undefined;

  const families = tagsNamed(event, "W");
  const selectors = tagsNamed(event, "S");
  if (
    !families.length ||
    !selectors.length ||
    [...families, ...selectors].some((tag) => tag.length !== 2 || !tag[1])
  )
    return undefined;
  const runnerFamilies = families.map((tag) => tag[1]);
  const runnerSelectors = selectors.map((tag) => tag[1]);
  const selectedFamilies = new Set<string>();
  for (const selector of runnerSelectors) {
    const separator = selector.indexOf(":");
    const family = selector.slice(0, separator);
    if (
      separator <= 0 ||
      separator === selector.length - 1 ||
      !runnerFamilies.includes(family)
    )
      return undefined;
    selectedFamilies.add(family);
  }
  if (
    new Set(runnerFamilies).size !== runnerFamilies.length ||
    new Set(runnerSelectors).size !== runnerSelectors.length ||
    runnerFamilies.some((family) => !selectedFamilies.has(family))
  )
    return undefined;

  const [, encryption, pubkey, ...relays] = inboxes[0];
  if (
    encryption !== "nip44-v2" ||
    !/^[0-9a-f]{64}$/.test(pubkey ?? "") ||
    pubkey === event.pubkey ||
    !relays.length ||
    new Set(relays).size !== relays.length
  )
    return undefined;
  for (const relay of relays) {
    try {
      const url = new URL(relay);
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        normalizeUrl(relay) !== relay
      )
        return undefined;
    } catch {
      return undefined;
    }
  }

  let environment: ProviderDetails["environment"];
  const environments = tagsNamed(event, "x");
  if (environments.length > 1) return undefined;
  if (environments.length) {
    const [, hash, hint] = environments[0];
    if (environments[0].length !== 3 || !/^[0-9a-f]{64}$/.test(hash ?? ""))
      return undefined;
    try {
      const url = new URL(hint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !new RegExp(`^${hash}(?:\\.[a-zA-Z0-9]+)?$`).test(
          url.pathname.split("/").pop() ?? "",
        )
      )
        return undefined;
    } catch {
      return undefined;
    }
    environment = { hash, url: hint };
  }
  return {
    expiration: expires,
    offeringId: ids[0][1],
    runnerFamilies,
    runnerSelectors,
    isolation: boundary,
    capacity: { total, available },
    allocationInbox: { pubkey, relays },
    environment,
  };
}

function details(event: NostrEvent): ProviderDetails | undefined {
  return getOrComputeCachedValue(event, DetailsSymbol, () =>
    event.kind === CI_LEGACY_PROVIDER_ADVERTISEMENT_KIND
      ? legacyDetails(event)
      : offeringDetails(event),
  );
}

export function isValidCIProviderAdvertisement(
  event: NostrEvent,
): event is CIProviderAdvertisementEvent {
  return details(event) !== undefined;
}

export class CIProviderAdvertisement extends EventCast<CIProviderAdvertisementEvent> {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (!isValidCIProviderAdvertisement(event))
      throw new Error("Invalid CI provider advertisement");
    super(event, store);
  }

  get pubkey(): string {
    return this.event.pubkey;
  }
  get isLegacy(): boolean {
    return this.event.kind === CI_LEGACY_PROVIDER_ADVERTISEMENT_KIND;
  }
  get expiration(): number {
    return details(this.event)!.expiration;
  }
  get offeringId(): string | undefined {
    return details(this.event)!.offeringId;
  }
  get runnerFamilies(): string[] {
    return details(this.event)!.runnerFamilies;
  }
  get runnerSelectors(): string[] {
    return details(this.event)!.runnerSelectors;
  }
  get isolation(): CIProviderIsolation | undefined {
    return details(this.event)!.isolation;
  }
  get capacity(): ProviderDetails["capacity"] {
    return details(this.event)!.capacity;
  }
  get allocationInbox(): ProviderDetails["allocationInbox"] {
    return details(this.event)!.allocationInbox;
  }
  get environment(): ProviderDetails["environment"] {
    return details(this.event)!.environment;
  }
}

/** Retain observed expirations only for this page visit, without resurrecting replaced offerings. */
export function retainProviderAdvertisements(
  previous: NostrEvent[],
  current: NostrEvent[],
  now: number,
): NostrEvent[] {
  const identity = (event: NostrEvent) =>
    `${event.kind}:${event.pubkey}:${
      event.kind === CI_NIX_PROVIDER_ADVERTISEMENT_KIND
        ? (tagsNamed(event, "d")[0]?.[1] ?? "")
        : ""
    }`;
  const candidates = [
    ...current,
    ...previous.filter((event) => {
      const expires = expiration(event);
      return expires !== undefined && expires <= now;
    }),
  ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const latest = new Map<string, NostrEvent>();
  for (const event of candidates) {
    const key = identity(event);
    if (!latest.has(key)) latest.set(key, event);
  }
  // Choose replacements before validation: a malformed latest event must not
  // revive an older claim of available capacity.
  return [...latest.values()];
}
