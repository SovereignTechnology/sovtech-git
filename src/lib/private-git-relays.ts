import type { EventSigner } from "applesauce-core";
import { verifyEvent, type NostrEvent } from "nostr-tools";

import { normalizeUrl } from "@/lib/url";

/** GRASP-08 encrypted private Git relay list. */
export const PRIVATE_GIT_RELAY_LIST_KIND = 10_318;

export type PrivateGitRelayListDecodeFailure = "invalid" | "signer";

export class PrivateGitRelayListDecodeError extends Error {
  constructor(
    readonly failure: PrivateGitRelayListDecodeFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrivateGitRelayListDecodeError";
  }
}

interface PrivateGitRelayListCache {
  /** Event ID whose authenticated ciphertext produced these relay URLs. */
  eventId: string;
  relayUrls: string[];
}

// Retain recent versions because relays can replay older events after reload.
const PRIVATE_GIT_RELAY_LIST_CACHE_LIMIT = 5;
const pendingDecodes = new Map<string, Promise<string[]>>();

function privateGitRelayListCacheKey(pubkey: string, eventId?: string): string {
  const prefix = `private_git_relay_list:${pubkey}`;
  return eventId ? `${prefix}:${eventId}` : prefix;
}

function loadPrivateGitRelayListCache(
  pubkey: string,
  eventId: string,
): PrivateGitRelayListCache | undefined {
  try {
    // Read the previous single-entry format too, without losing an already
    // approved decryption when upgrading.
    const raw =
      localStorage.getItem(privateGitRelayListCacheKey(pubkey, eventId)) ??
      localStorage.getItem(privateGitRelayListCacheKey(pubkey));
    if (!raw) return undefined;

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.eventId !== eventId ||
      !Array.isArray(candidate.relayUrls) ||
      !candidate.relayUrls.every(
        (relay): relay is string => typeof relay === "string",
      )
    ) {
      return undefined;
    }

    const cache = {
      eventId,
      relayUrls: normalizePrivateGitRelayUrls(candidate.relayUrls),
    };
    savePrivateGitRelayListCache(pubkey, cache);
    return cache;
  } catch {
    return undefined;
  }
}

function savePrivateGitRelayListCache(
  pubkey: string,
  cache: PrivateGitRelayListCache,
): void {
  try {
    const prefix = privateGitRelayListCacheKey(pubkey);
    const currentKey = privateGitRelayListCacheKey(pubkey, cache.eventId);
    localStorage.setItem(
      currentKey,
      JSON.stringify({ ...cache, lastUsed: Date.now() }),
    );

    const entries: { key: string; lastUsed: number }[] = [];
    // Include the legacy single-entry cache in the limit. Entries written
    // before recency tracking are evicted first; a hit promotes them.
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || (key !== prefix && !key.startsWith(`${prefix}:`))) {
        continue;
      }
      let lastUsed = 0;
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        if (typeof value === "object" && value !== null) {
          const record = value as Record<string, unknown>;
          if (
            typeof record.lastUsed === "number" &&
            Number.isFinite(record.lastUsed)
          ) {
            lastUsed = record.lastUsed;
          }
          // Remove the legacy duplicate after successfully storing its
          // promoted per-event entry.
          if (key === prefix && record.eventId === cache.eventId) {
            entries.push({ key, lastUsed: -Infinity });
            continue;
          }
        }
      } catch {
        // Malformed cache records are also candidates for eviction.
      }
      entries.push({ key, lastUsed });
    }
    entries.sort((a, b) => {
      if (a.key === currentKey) return -1;
      if (b.key === currentKey) return 1;
      return b.lastUsed - a.lastUsed;
    });
    for (const [index, entry] of entries.entries()) {
      if (
        index >= PRIVATE_GIT_RELAY_LIST_CACHE_LIMIT ||
        entry.lastUsed === -Infinity
      ) {
        localStorage.removeItem(entry.key);
      }
    }
  } catch {
    // Storage is an optimization; decoding still works without it.
  }
}

function validateRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list contains an invalid relay URL",
      { cause },
    );
  }

  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list contains an invalid relay URL",
    );
  }

  return normalizeUrl(url.toString());
}

export function normalizePrivateGitRelayUrls(
  relayUrls: readonly string[],
): string[] {
  return [...new Set(relayUrls.map(validateRelayUrl))].sort();
}

function parsePrivateItems(plaintext: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch (cause) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list plaintext is not valid JSON",
      { cause },
    );
  }

  if (!Array.isArray(value)) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list plaintext must be an array",
    );
  }

  const relayUrls: string[] = [];
  for (const item of value) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      item[0] !== "g" ||
      typeof item[1] !== "string"
    ) {
      throw new PrivateGitRelayListDecodeError(
        "invalid",
        "Private Git relay list contains a non-g item",
      );
    }
    relayUrls.push(item[1]);
  }

  return normalizePrivateGitRelayUrls(relayUrls);
}

/** Verify cryptographically without trusting cached symbol metadata. */
export function verifyPrivateGitRelayListEventSignature(
  event: NostrEvent,
): boolean {
  const plainEvent: NostrEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
  return verifyEvent(plainEvent);
}

export function isStructurallyValidPrivateGitRelayListEvent(
  event: NostrEvent,
  pubkey: string,
): boolean {
  return (
    verifyPrivateGitRelayListEventSignature(event) &&
    event.kind === PRIVATE_GIT_RELAY_LIST_KIND &&
    event.pubkey === pubkey &&
    event.tags.length === 0
  );
}

/** Ignore unverified winners when choosing the next replacement timestamp. */
export function privateGitRelayListTimestampFloor(
  event: NostrEvent | undefined,
  pubkey: string,
): number {
  return event && isStructurallyValidPrivateGitRelayListEvent(event, pubkey)
    ? event.created_at
    : 0;
}

export async function decodePrivateGitRelayListEvent(
  event: NostrEvent,
  pubkey: string,
  signer: EventSigner,
): Promise<string[]> {
  if (!isStructurallyValidPrivateGitRelayListEvent(event, pubkey)) {
    throw new PrivateGitRelayListDecodeError(
      "invalid",
      "Private Git relay list has an invalid public envelope",
    );
  }
  const cached = loadPrivateGitRelayListCache(pubkey, event.id);
  if (cached) return cached.relayUrls;

  const key = privateGitRelayListCacheKey(pubkey, event.id);
  const pending = pendingDecodes.get(key);
  if (pending) return [...(await pending)];

  const promise = decryptPrivateGitRelayListEvent(event, pubkey, signer);
  pendingDecodes.set(key, promise);
  try {
    return [...(await promise)];
  } finally {
    // Rejections must remain retryable through the caller's manual retry.
    pendingDecodes.delete(key);
  }
}

async function decryptPrivateGitRelayListEvent(
  event: NostrEvent,
  pubkey: string,
  signer: EventSigner,
): Promise<string[]> {
  if (!signer.nip44) {
    throw new PrivateGitRelayListDecodeError(
      "signer",
      "This signer does not support NIP-44 decryption",
    );
  }

  let plaintext: string;
  try {
    plaintext = await signer.nip44.decrypt(pubkey, event.content);
  } catch (cause) {
    throw new PrivateGitRelayListDecodeError(
      "signer",
      "Failed to decrypt the private Git relay list",
      { cause },
    );
  }

  const relayUrls = parsePrivateItems(plaintext);
  savePrivateGitRelayListCache(pubkey, { eventId: event.id, relayUrls });
  return relayUrls;
}

/** Sign an exact encrypted kind:10318 replacement with no public tags. */
export async function createPrivateGitRelayListEvent(
  pubkey: string,
  signer: EventSigner,
  relayUrls: readonly string[],
  minimumCreatedAt = 0,
): Promise<NostrEvent> {
  if (!signer.nip44) {
    throw new Error(
      "Private repository discovery requires a signer that supports NIP-44",
    );
  }

  const normalized = normalizePrivateGitRelayUrls(relayUrls);
  const plaintext = JSON.stringify(normalized.map((url) => ["g", url]));
  const content = await signer.nip44.encrypt(pubkey, plaintext);
  const unsigned = {
    kind: PRIVATE_GIT_RELAY_LIST_KIND,
    content,
    tags: [],
    created_at: Math.max(Math.floor(Date.now() / 1_000), minimumCreatedAt + 1),
  };
  const event = await signer.signEvent(unsigned);

  if (
    !verifyEvent(event) ||
    event.pubkey !== pubkey ||
    event.kind !== unsigned.kind ||
    event.content !== unsigned.content ||
    event.created_at !== unsigned.created_at ||
    event.tags.length !== 0
  ) {
    throw new Error("The signer changed the private Git relay list envelope");
  }

  const roundTrip = await decodePrivateGitRelayListEvent(event, pubkey, signer);
  if (
    roundTrip.length !== normalized.length ||
    roundTrip.some((url, index) => url !== normalized[index])
  ) {
    throw new Error("The signer returned an unreadable private Git relay list");
  }

  return event;
}
