/**
 * Account-owned NIP-78 notification-state synchronization.
 *
 * The encrypted key envelope and the derived-key read/archive state are one
 * logical replaceable scope. This service owns their exact relay filters,
 * EOSE-backed coverage, decryption, local-delta replay, and debounced writes.
 * See docs/replaceable-preflight.md, "Notification-state adoption decision".
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { mapEventsToStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import { AppDataFactory } from "applesauce-common/factories";
import {
  getAppDataContent,
  isAppDataUnlocked,
  unlockAppData,
} from "applesauce-common/helpers/app-data";
import { onlyEvents } from "applesauce-relay";
import { PrivateKeySigner } from "applesauce-signers/signers";
import { generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools";
import {
  BehaviorSubject,
  combineLatest,
  type Observable,
  type Subscription,
} from "rxjs";
import { distinctUntilChanged, map, startWith } from "rxjs/operators";
import {
  DEFAULT_READ_STATE,
  NIP78_KIND,
  NOTIFICATION_NSEC_D_TAG,
  NOTIFICATION_STATE_D_TAG,
  parseReadState,
  type NotificationReadState,
} from "@/lib/notifications";
import {
  createRelaySubscriptionCoverage,
  type RelaySubscriptionCoverage,
} from "@/lib/relaySubscriptionCoverage";
import {
  assessMailboxDiscovery,
  buildRelayCoverageGroup,
  isRelayCoverageInFlight,
  mailboxOutboxesObservable,
  meetsBoundedTwoThirdsThreshold,
  type MailboxDiscovery,
  type PreflightCoverageAssessment,
  type RelayCoverageGroup,
} from "@/lib/replaceablePreflightCoverage";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { normalizeUrl } from "@/lib/url";
import { cacheRequest } from "@/services/cache";
import { eventStore, pool } from "@/services/nostr";
import { fallbackRelays, lookupRelays } from "@/services/settings";
import {
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
  userIdentityCoverage,
} from "@/services/userIdentityCoverage";

import {
  repoSelectionFilter,
  startRepoSelectionSync,
} from "./repoSelectionSync";

interface NotificationKeyEnvelope {
  "nsec-for-notification-state"?: string;
  /** Legacy field written before the purpose-specific field was introduced. */
  nsec?: string;
}

export type NotificationStateUpdater = (
  previous: NotificationReadState,
) => NotificationReadState;

export type NotificationSyncStage = "envelope" | "state";

export type NotificationSyncState = (
  | {
      status: "checking";
      stage: NotificationSyncStage;
      message: string;
      pendingChanges: boolean;
    }
  | {
      status: "ready";
      stage: "state";
      message: string;
      pendingChanges: boolean;
    }
  | {
      status: "paused";
      stage: NotificationSyncStage;
      message: string;
      pendingChanges: boolean;
    }
) & { relayCoverage?: RelayCoverageGroup[] };

export interface NotificationSyncController {
  readonly state$: BehaviorSubject<NotificationSyncState>;
  /** Apply immediately in the UI and retain as a rebasable local delta. */
  enqueue(update: NotificationStateUpdater): void;
  /** Retry only the currently failed decrypt, coverage, or publish step. */
  retry(): void;
  /** Create the notification key on the user's explicit request for ordering sync. */
  enableRepoSelectionSync(): void;
  stop(): void;
}

export interface NotificationRelayScope {
  outboxes: string[];
  fallbacks: string[];
  lookups: string[];
  relays: string[];
  mailboxDiscovery: MailboxDiscovery;
  /** A kind 10002 relay list was actually observed, not merely proven absent. */
  hasMailboxEvent: boolean;
}

interface NsecCache {
  hexKey: string;
  eventId: string;
  createdAt: number;
}

interface ResolvedNotificationSigner {
  signer: PrivateKeySigner;
  envelopeEventId: string;
}

const PUBLISH_DEBOUNCE_MS = 2_000;
const CACHE_HYDRATION_TIMEOUT_MS = 1_000;
const signerCache = new Map<string, ResolvedNotificationSigner>();
const signerInFlight = new Map<
  string,
  Promise<ResolvedNotificationSigner | null>
>();

function nsecCacheKey(pubkey: string): string {
  return `notifications_nsec:${pubkey}`;
}

function loadNsecCache(pubkey: string): NsecCache | null {
  try {
    const raw = localStorage.getItem(nsecCacheKey(pubkey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "hexKey" in parsed &&
      "eventId" in parsed &&
      "createdAt" in parsed &&
      typeof (parsed as NsecCache).hexKey === "string" &&
      typeof (parsed as NsecCache).eventId === "string" &&
      typeof (parsed as NsecCache).createdAt === "number"
    ) {
      return parsed as NsecCache;
    }
  } catch {
    // A corrupt or unavailable local cache is simply not evidence.
  }
  return null;
}

function saveNsecCache(pubkey: string, cache: NsecCache): void {
  try {
    localStorage.setItem(nsecCacheKey(pubkey), JSON.stringify(cache));
  } catch {
    // The warm relay owner remains authoritative when localStorage is absent.
  }
}

function clearNsecCache(pubkey: string): void {
  try {
    localStorage.removeItem(nsecCacheKey(pubkey));
  } catch {
    // ignore
  }
}

function getNotificationKey(
  content: NotificationKeyEnvelope | undefined,
): string | undefined {
  return content?.["nsec-for-notification-state"] ?? content?.nsec;
}

function envelopeFilter(pubkey: string): Filter {
  return {
    kinds: [NIP78_KIND],
    authors: [pubkey],
    "#d": [NOTIFICATION_NSEC_D_TAG],
  } as Filter;
}

function mailboxFilter(pubkey: string): Filter {
  return { kinds: [10002], authors: [pubkey] } as Filter;
}

function stateFilter(notificationPubkey: string): Filter {
  return {
    kinds: [NIP78_KIND],
    authors: [notificationPubkey],
    "#d": [NOTIFICATION_STATE_D_TAG],
  } as Filter;
}

function currentEvent(filter: Filter): NostrEvent | undefined {
  return eventStore.getByFilters(filter)[0] as NostrEvent | undefined;
}

async function hydrateCachedNotificationEvents(
  filters: Filter[],
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const events = await Promise.race([
      cacheRequest(filters),
      new Promise<NostrEvent[]>((resolve) => {
        timeoutId = setTimeout(() => resolve([]), CACHE_HYDRATION_TIMEOUT_MS);
      }),
    ]);
    for (const event of events) eventStore.add(event);
  } catch {
    // IndexedDB is useful additional evidence, not a prerequisite for sync.
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function stateEquals(
  first: NotificationReadState,
  second: NotificationReadState,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function syncStateEquals(
  first: NotificationSyncState,
  second: NotificationSyncState,
): boolean {
  return (
    first.status === second.status &&
    first.stage === second.stage &&
    first.message === second.message &&
    first.pendingChanges === second.pendingChanges &&
    JSON.stringify(first.relayCoverage) === JSON.stringify(second.relayCoverage)
  );
}

function replayUpdates(
  base: NotificationReadState,
  updates: readonly NotificationStateUpdater[],
): NotificationReadState {
  return updates.reduce((state, update) => update(state), base);
}

/** Derive the notification state author without prompting the account signer. */
export function getCachedNotificationPubkey(userPubkey: string): string | null {
  const cache = loadNsecCache(userPubkey);
  if (!cache) return null;
  try {
    return getPublicKey(hexToBytes(cache.hexKey));
  } catch {
    return null;
  }
}

function cacheOutranksEnvelope(
  cache: NsecCache,
  envelope: NostrEvent,
): boolean {
  if (cache.eventId === envelope.id) return true;
  if (cache.createdAt !== envelope.created_at) {
    return cache.createdAt > envelope.created_at;
  }
  return cache.eventId < envelope.id;
}

async function activeUserSigner(pubkey: string) {
  const { accounts } = await import("@/services/accounts");
  const active = accounts.active$.getValue();
  if (!active || active.pubkey !== pubkey) {
    throw new Error("The active notification account changed");
  }
  return active.signer;
}

function notificationGroupIds(pubkey: string): string[] {
  return [`outbox:${pubkey}`, "fallback-relays"];
}

async function createNotificationSigner(
  pubkey: string,
  canCreate: () => boolean,
): Promise<ResolvedNotificationSigner | null> {
  const userSigner = await activeUserSigner(pubkey);
  const secretKey = generateSecretKey();
  const hexKey = bytesToHex(secretKey);
  const userSignerPubkey = await userSigner.getPublicKey();
  const envelopeContent = { "nsec-for-notification-state": hexKey };
  const signed = await AppDataFactory.create(
    NOTIFICATION_NSEC_D_TAG,
    envelopeContent,
  )
    .as(userSigner)
    .encryptedContent(
      userSignerPubkey,
      JSON.stringify(envelopeContent),
      "nip44",
    )
    .sign();

  const { outboxStore } = await import("@/services/outbox");
  // A signer prompt may outlive the owner or the evidence of key absence.
  if (!canCreate()) return null;

  const signer = PrivateKeySigner.fromKey(secretKey);
  const resolved = { signer, envelopeEventId: signed.id };
  signerCache.set(pubkey, resolved);
  saveNsecCache(pubkey, {
    hexKey,
    eventId: signed.id,
    createdAt: signed.created_at,
  });
  eventStore.add(signed);

  await outboxStore.publish(signed, notificationGroupIds(pubkey), {
    hidden: true,
  });
  return resolved;
}

/**
 * Resolve an existing notification signer, optionally bootstrapping only after
 * the caller has established warm absence for the envelope coordinate.
 */
async function resolveNotificationSigner(
  pubkey: string,
  envelope: NostrEvent | undefined,
  allowCreate: false | (() => boolean),
): Promise<ResolvedNotificationSigner | null> {
  const nsecCache = loadNsecCache(pubkey);
  const usableCache =
    nsecCache && (!envelope || cacheOutranksEnvelope(nsecCache, envelope))
      ? nsecCache
      : null;
  if (nsecCache && !usableCache) clearNsecCache(pubkey);

  const sourceId = usableCache?.eventId ?? envelope?.id ?? "absent";
  const memory = signerCache.get(pubkey);
  if (memory?.envelopeEventId === sourceId) return memory;

  const inFlightKey = `${pubkey}:${sourceId}:${allowCreate ? "create" : "read"}`;
  const existing = signerInFlight.get(inFlightKey);
  if (existing) return existing;

  const promise = (async (): Promise<ResolvedNotificationSigner | null> => {
    if (usableCache) {
      const signer = PrivateKeySigner.fromKey(hexToBytes(usableCache.hexKey));
      const resolved = { signer, envelopeEventId: usableCache.eventId };
      signerCache.set(pubkey, resolved);
      return resolved;
    }

    if (envelope) {
      const userSigner = await activeUserSigner(pubkey);
      if (!isAppDataUnlocked(envelope)) {
        await unlockAppData(envelope, userSigner);
      }
      const notificationKey = getNotificationKey(
        getAppDataContent<NotificationKeyEnvelope>(envelope),
      );
      if (!notificationKey) {
        throw new Error(
          "The encrypted notification key did not contain a usable key",
        );
      }
      const signer = PrivateKeySigner.fromKey(hexToBytes(notificationKey));
      const resolved = { signer, envelopeEventId: envelope.id };
      signerCache.set(pubkey, resolved);
      saveNsecCache(pubkey, {
        hexKey: notificationKey,
        eventId: envelope.id,
        createdAt: envelope.created_at,
      });
      return resolved;
    }

    return allowCreate ? createNotificationSigner(pubkey, allowCreate) : null;
  })().finally(() => signerInFlight.delete(inFlightKey));

  signerInFlight.set(inFlightKey, promise);
  return promise;
}

export function evictNotificationSigner(pubkey: string): void {
  signerCache.delete(pubkey);
  for (const key of signerInFlight.keys()) {
    if (key.startsWith(`${pubkey}:`)) signerInFlight.delete(key);
  }
}

/**
 * Resolve the actual NIP-78 publication frontier. Fallback relays are kept as
 * a distinct voting group and URLs shared with outboxes vote only as outboxes.
 */
export function notificationRelayScopeObservable(
  pubkey: string,
): Observable<NotificationRelayScope> {
  return combineLatest([
    mailboxOutboxesObservable(eventStore, pubkey),
    fallbackRelays,
    lookupRelays,
    userIdentityCoverage.changes$.pipe(startWith(undefined)),
  ]).pipe(
    map(([mailboxOutboxes, configuredFallbacks, configuredLookups]) => {
      const outboxes = [...new Set(mailboxOutboxes ?? [])].sort();
      const outboxSet = new Set(outboxes);
      const fallbacks = [...new Set(configuredFallbacks.map(normalizeUrl))]
        .filter((relay) => !outboxSet.has(relay))
        .sort();
      const lookups = [...new Set(configuredLookups.map(normalizeUrl))].sort();
      return {
        outboxes,
        fallbacks,
        lookups,
        relays: [...outboxes, ...fallbacks],
        mailboxDiscovery: assessMailboxDiscovery(
          userIdentityCoverage.get(pubkey),
          lookups,
          mailboxOutboxes !== undefined,
        ),
        hasMailboxEvent: mailboxOutboxes !== undefined,
      };
    }),
    distinctUntilChanged(
      (first, second) =>
        first.outboxes.length === second.outboxes.length &&
        first.outboxes.every(
          (relay, index) => relay === second.outboxes[index],
        ) &&
        first.fallbacks.length === second.fallbacks.length &&
        first.fallbacks.every(
          (relay, index) => relay === second.fallbacks[index],
        ) &&
        first.lookups.length === second.lookups.length &&
        first.lookups.every(
          (relay, index) => relay === second.lookups[index],
        ) &&
        first.mailboxDiscovery === second.mailboxDiscovery &&
        first.hasMailboxEvent === second.hasMailboxEvent,
    ),
  );
}

function meetsNotificationCoverageThreshold(
  coveredOutboxes: number,
  totalOutboxes: number,
  coveredFallbacks: number,
  totalFallbacks: number,
): boolean {
  if (totalOutboxes === 0) {
    return meetsBoundedTwoThirdsThreshold(coveredFallbacks, totalFallbacks);
  }
  if (coveredOutboxes === 0) return false;
  if (coveredOutboxes === 1) return coveredFallbacks >= 2;
  return coveredOutboxes >= 3 || coveredOutboxes / totalOutboxes >= 0.5;
}

/**
 * Creating a key replaces the envelope for every device, so absence must be
 * proven on the relays the envelope would live on: an observed relay list
 * rather than an inferred lack of one, every outbox relay (all but one when
 * there are at least three), and the usual backup-relay quorum.
 */
function meetsBootstrapCoverageThreshold(
  coveredOutboxes: number,
  totalOutboxes: number,
  coveredFallbacks: number,
  totalFallbacks: number,
): boolean {
  if (totalOutboxes === 0) return false;
  const requiredOutboxes =
    totalOutboxes >= 3 ? totalOutboxes - 1 : totalOutboxes;
  if (coveredOutboxes < requiredOutboxes) return false;
  return (
    totalFallbacks === 0 ||
    meetsBoundedTwoThirdsThreshold(coveredFallbacks, totalFallbacks)
  );
}

function countRelayCoverage(
  scope: NotificationRelayScope,
  coverage: RelaySubscriptionCoverage,
) {
  const covered = (relays: string[]) =>
    relays.filter((relay) => coverage.isCovered(relay)).length;
  const inFlight = (relays: string[]) =>
    relays.filter((relay) => isRelayCoverageInFlight(coverage, relay)).length;
  const coveredOutboxes = covered(scope.outboxes);
  const coveredFallbacks = covered(scope.fallbacks);
  return {
    coveredOutboxes,
    coveredFallbacks,
    possibleOutboxes: coveredOutboxes + inFlight(scope.outboxes),
    possibleFallbacks: coveredFallbacks + inFlight(scope.fallbacks),
    summary: `Outbox relays: ${coveredOutboxes}/${scope.outboxes.length} ready. Backup relays: ${coveredFallbacks}/${scope.fallbacks.length} ready.`,
  };
}

function assessCoverage(
  scope: NotificationRelayScope,
  coverage: RelaySubscriptionCoverage,
): PreflightCoverageAssessment {
  if (scope.mailboxDiscovery !== "known") {
    return {
      met: false,
      possible: scope.mailboxDiscovery === "checking",
      summary:
        scope.mailboxDiscovery === "checking"
          ? "Mailbox discovery is still checking the configured user-index relays."
          : "Mailbox discovery could not confirm whether you have configured outbox relays.",
    };
  }

  const counts = countRelayCoverage(scope, coverage);
  return {
    met: meetsNotificationCoverageThreshold(
      counts.coveredOutboxes,
      scope.outboxes.length,
      counts.coveredFallbacks,
      scope.fallbacks.length,
    ),
    possible: meetsNotificationCoverageThreshold(
      counts.possibleOutboxes,
      scope.outboxes.length,
      counts.possibleFallbacks,
      scope.fallbacks.length,
    ),
    summary: counts.summary,
  };
}

/** Stricter evidence for the one destructive step: minting a new key. */
function assessBootstrapCoverage(
  scope: NotificationRelayScope,
  coverage: RelaySubscriptionCoverage,
): PreflightCoverageAssessment {
  if (!scope.hasMailboxEvent) {
    return {
      met: false,
      possible: scope.mailboxDiscovery === "checking",
      summary:
        scope.mailboxDiscovery === "checking"
          ? "Mailbox discovery is still looking for your relay list."
          : "No relay list (kind 10002) was found for your account. Publish your relay list in settings before a shared notification key can be created.",
    };
  }

  const counts = countRelayCoverage(scope, coverage);
  return {
    met: meetsBootstrapCoverageThreshold(
      counts.coveredOutboxes,
      scope.outboxes.length,
      counts.coveredFallbacks,
      scope.fallbacks.length,
    ),
    possible: meetsBootstrapCoverageThreshold(
      counts.possibleOutboxes,
      scope.outboxes.length,
      counts.possibleFallbacks,
      scope.fallbacks.length,
    ),
    summary: `Creating the key needs every outbox relay checked. ${counts.summary}`,
  };
}

type CoveragePurpose = "check" | "create";

function coverageState(
  stage: NotificationSyncStage,
  assessment: PreflightCoverageAssessment,
  pendingChanges: boolean,
  relayCoverage: RelayCoverageGroup[],
  purpose: CoveragePurpose,
): NotificationSyncState {
  if (assessment.possible) {
    return {
      status: "checking",
      stage,
      pendingChanges,
      relayCoverage,
      message:
        purpose === "create"
          ? `Checking relay coverage before creating the shared notification key. ${assessment.summary}`
          : `Checking the encrypted notification ${stage}. ${assessment.summary}`,
    };
  }
  return {
    status: "paused",
    stage,
    pendingChanges,
    relayCoverage,
    message:
      purpose === "create"
        ? `The shared notification key cannot be created safely yet. ${assessment.summary}`
        : `Cross-device notification state cannot be checked safely yet. ${assessment.summary}`,
  };
}

async function decryptStateEvent(
  event: NostrEvent,
  signer: PrivateKeySigner,
): Promise<NotificationReadState> {
  if (!isAppDataUnlocked(event)) await unlockAppData(event, signer);
  const content = getAppDataContent<NotificationReadState>(event);
  if (!content) throw new Error("The encrypted notification state is empty");
  return parseReadState(content);
}

/** Own the notification envelope, notification state, and repository scores. */
export function startNotificationSync(
  pubkey: string,
  readState$: BehaviorSubject<NotificationReadState>,
): NotificationSyncController {
  const state$ = new BehaviorSubject<NotificationSyncState>({
    status: "checking",
    stage: "envelope",
    message: "Checking your encrypted notification state...",
    pendingChanges: false,
  });
  const relayUrls$ = new BehaviorSubject<string[]>([]);
  let relayScope: NotificationRelayScope = {
    outboxes: [],
    fallbacks: [],
    lookups: [],
    relays: [],
    mailboxDiscovery: "checking",
    hasMailboxEvent: false,
  };
  let coverage: RelaySubscriptionCoverage | undefined;
  let coverageChangesSub: Subscription | undefined;
  let relaySub: Subscription | undefined;
  let storeSub: Subscription | undefined;
  let scopeNotificationPubkey: string | null =
    getCachedNotificationPubkey(pubkey);
  let resolvedSigner: ResolvedNotificationSigner | null = null;
  let appliedStateEventId: string | null = null;
  let failedEnvelopeId: string | null = null;
  let failedStateId: string | null = null;
  let baseState = readState$.getValue() ?? { ...DEFAULT_READ_STATE };
  let pendingUpdates: NotificationStateUpdater[] = [];
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let publishRequested = false;
  let publishing = false;
  let lastPublishedEventId: string | null = null;
  let ownerRevision = 0;
  let initialCacheHydration: Promise<void> = Promise.resolve();
  let bootstrapCacheCheckedRevision = -1;
  let coverageBlocked = false;
  let reconcileRunning = false;
  let reconcileAgain = false;
  let stopped = false;

  // Invariant: readState$ is always baseState with every pending updater
  // replayed in order. A remote winner replaces baseState; pending local intent
  // is then reapplied before the next signature is created.

  const currentFilters = (notificationPubkey: string | null): Filter[] => [
    envelopeFilter(pubkey),
    ...(notificationPubkey
      ? [
          stateFilter(notificationPubkey),
          repoSelectionFilter(notificationPubkey),
        ]
      : []),
  ];

  const emitState = (next: NotificationSyncState) => {
    if (next.stage === "envelope" || next.relayCoverage)
      selectionSync.availability(next);
    if (!syncStateEquals(state$.getValue(), next)) state$.next(next);
  };

  const emitReady = () => {
    coverageBlocked = false;
    emitState({
      status: "ready",
      stage: "state",
      message: pendingUpdates.length
        ? "Cross-device notification state is ready; local changes are queued."
        : "Cross-device notification state is up to date.",
      pendingChanges: pendingUpdates.length > 0,
    });
  };

  const emitPaused = (stage: NotificationSyncStage, message: string) => {
    coverageBlocked = false;
    emitState({
      status: "paused",
      stage,
      message,
      pendingChanges: pendingUpdates.length > 0,
    });
  };

  const emitCoverageState = (
    stage: NotificationSyncStage,
    assessment: PreflightCoverageAssessment,
    purpose: CoveragePurpose = "check",
  ) => {
    const relayCoverage = [
      ...(relayScope.mailboxDiscovery === "known"
        ? []
        : [
            buildRelayCoverageGroup(
              "User-index relays",
              relayScope.lookups,
              userIdentityCoverage.get(pubkey),
            ),
          ]),
      buildRelayCoverageGroup("Outbox relays", relayScope.outboxes, coverage),
      buildRelayCoverageGroup("Backup relays", relayScope.fallbacks, coverage),
    ];
    const next = coverageState(
      stage,
      assessment,
      pendingUpdates.length > 0,
      relayCoverage,
      purpose,
    );
    coverageBlocked = next.status === "paused";
    emitState(next);
  };

  const requestReconcile = () => {
    if (stopped) return;
    reconcileAgain = true;
    if (reconcileRunning) return;
    reconcileRunning = true;
    void (async () => {
      try {
        while (reconcileAgain && !stopped) {
          reconcileAgain = false;
          await reconcileOnce();
        }
      } finally {
        reconcileRunning = false;
      }
    })();
  };

  const selectionSync = startRepoSelectionSync(pubkey, requestReconcile);

  const restartWarmOwner = (notificationPubkey: string | null) => {
    ownerRevision += 1;
    const revision = ownerRevision;
    scopeNotificationPubkey = notificationPubkey;
    appliedStateEventId = null;
    coverageBlocked = false;
    coverageChangesSub?.unsubscribe();
    coverage?.stop();
    relaySub?.unsubscribe();
    storeSub?.unsubscribe();

    const nextCoverage = createRelaySubscriptionCoverage({
      settlementTimeoutMs: USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
    });
    coverage = nextCoverage;
    coverageChangesSub = nextCoverage.changes$.subscribe(requestReconcile);
    const filters = currentFilters(notificationPubkey);
    initialCacheHydration = hydrateCachedNotificationEvents(filters);
    void initialCacheHydration.then(() => {
      if (!stopped && revision === ownerRevision) requestReconcile();
    });
    storeSub = (
      eventStore.timeline(filters) as unknown as Observable<NostrEvent[]>
    ).subscribe(() => requestReconcile());
    relaySub = resilientSubscription(pool, relayUrls$, filters, {
      retryCount: Infinity,
      onRelayLifecycle: (event) => nextCoverage.onLifecycle(event),
    })
      .pipe(onlyEvents(), mapEventsToStore(eventStore))
      .subscribe();
    requestReconcile();
  };

  const flushPublish = async () => {
    if (
      stopped ||
      publishing ||
      !publishRequested ||
      pendingUpdates.length === 0 ||
      !resolvedSigner ||
      state$.getValue().status !== "ready"
    ) {
      return;
    }

    publishing = true;
    publishRequested = false;
    const revision = ownerRevision;
    const updateCount = pendingUpdates.length;
    const snapshot = readState$.getValue();
    try {
      const notificationPubkey = await resolvedSigner.signer.getPublicKey();
      const current = currentEvent(stateFilter(notificationPubkey));
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        (current?.created_at ?? 0) + 1,
      );
      const signed = await AppDataFactory.create<NotificationReadState>(
        NOTIFICATION_STATE_D_TAG,
        snapshot,
      )
        .as(resolvedSigner.signer)
        .created(createdAt)
        .encryptedContent(notificationPubkey, JSON.stringify(snapshot), "nip44")
        .sign();

      if (stopped || revision !== ownerRevision) return;
      lastPublishedEventId = signed.id;
      eventStore.add(signed);
      const { outboxStore } = await import("@/services/outbox");
      await outboxStore.publish(signed, notificationGroupIds(pubkey), {
        hidden: true,
      });
      if (stopped || revision !== ownerRevision) return;

      baseState = snapshot;
      pendingUpdates = pendingUpdates.slice(updateCount);
      const rebased = replayUpdates(baseState, pendingUpdates);
      if (!stateEquals(rebased, readState$.getValue()))
        readState$.next(rebased);
      appliedStateEventId = signed.id;
      emitReady();
      if (pendingUpdates.length > 0) {
        publishRequested = true;
        requestReconcile();
      }
    } catch (error) {
      publishRequested = true;
      emitPaused(
        "state",
        error instanceof Error
          ? `Cross-device notification state could not be saved: ${error.message}`
          : "Cross-device notification state could not be saved.",
      );
    } finally {
      publishing = false;
    }
  };

  async function reconcileOnce(): Promise<void> {
    const activeCoverage = coverage;
    if (!activeCoverage) return;
    const revision = ownerRevision;
    const ownerCacheHydration = initialCacheHydration;
    await ownerCacheHydration;
    if (stopped || revision !== ownerRevision) return;
    const envelope = currentEvent(envelopeFilter(pubkey));
    const envelopeSourceId = envelope?.id ?? "absent";

    if (failedEnvelopeId === envelopeSourceId) {
      emitPaused(
        "envelope",
        "The encrypted notification key could not be decrypted. Local notification controls still work, but cross-device state sync is paused.",
      );
      return;
    }

    try {
      const existing = await resolveNotificationSigner(pubkey, envelope, false);
      if (stopped || revision !== ownerRevision) return;
      resolvedSigner = existing;
    } catch (error) {
      if (stopped || revision !== ownerRevision) return;
      failedEnvelopeId = envelopeSourceId;
      emitPaused(
        "envelope",
        error instanceof Error
          ? `The encrypted notification key could not be decrypted: ${error.message}`
          : "The encrypted notification key could not be decrypted.",
      );
      return;
    }

    if (!resolvedSigner) {
      const assessment = assessCoverage(relayScope, activeCoverage);
      if (!assessment.met) {
        emitCoverageState("envelope", assessment);
        return;
      }
      // Confirmed envelope absence means no derived state coordinate exists.
      // Keep the envelope lease warm without prompting the account signer until
      // the user changes notification state for the first time or explicitly
      // enables ordering sync. A passive dashboard click never creates the key:
      // a persisted score would be a standing request to replace an envelope
      // that this relay scope merely fails to return.
      if (pendingUpdates.length === 0 && !selectionSync.keyRequested()) {
        selectionSync.availability({
          status: "local",
          message: "Repository ordering is stored on this device.",
        });
        emitReady();
        return;
      }

      // Replacing the envelope orphans every other device's encrypted state,
      // so absence needs stronger evidence than a routine publish.
      const bootstrap = assessBootstrapCoverage(relayScope, activeCoverage);
      if (!bootstrap.met) {
        emitCoverageState("envelope", bootstrap, "create");
        return;
      }

      // Bootstrap is destructive if an older envelope or mailbox frontier
      // exists only in the local cache. Re-check both once per owner revision
      // before its first key-creation attempt. This does not query the
      // configured relay frontier.
      if (bootstrapCacheCheckedRevision !== revision) {
        await hydrateCachedNotificationEvents([
          envelopeFilter(pubkey),
          mailboxFilter(pubkey),
        ]);
        if (stopped || revision !== ownerRevision) return;
        bootstrapCacheCheckedRevision = revision;
        // Let EventStore model emissions update the mailbox frontier and then
        // reassess coverage even when the cache contained no newer envelope.
        requestReconcile();
        return;
      }
      try {
        resolvedSigner = await resolveNotificationSigner(
          pubkey,
          envelope,
          () =>
            !stopped &&
            revision === ownerRevision &&
            !currentEvent(envelopeFilter(pubkey)) &&
            assessBootstrapCoverage(relayScope, activeCoverage).met,
        );
      } catch (error) {
        if (stopped || revision !== ownerRevision) return;
        failedEnvelopeId = envelopeSourceId;
        emitPaused(
          "envelope",
          error instanceof Error
            ? `The notification key could not be created: ${error.message}`
            : "The notification key could not be created.",
        );
        return;
      }
      if (stopped || revision !== ownerRevision || !resolvedSigner) return;
    }

    const notificationPubkey = await resolvedSigner.signer.getPublicKey();
    if (stopped || revision !== ownerRevision) return;
    if (notificationPubkey !== scopeNotificationPubkey) {
      restartWarmOwner(notificationPubkey);
      return;
    }

    const assessment = assessCoverage(relayScope, activeCoverage);
    if (!assessment.met) {
      emitCoverageState("state", assessment);
      return;
    }

    const selectionSigner = resolvedSigner;
    await selectionSync.reconcile(
      selectionSigner.signer,
      () =>
        !stopped &&
        revision === ownerRevision &&
        resolvedSigner === selectionSigner &&
        (currentEvent(envelopeFilter(pubkey))?.id ?? "absent") ===
          envelopeSourceId &&
        assessCoverage(relayScope, activeCoverage).met,
    );
    if (stopped || revision !== ownerRevision) return;

    const latest = currentEvent(stateFilter(notificationPubkey));
    if (latest?.id === lastPublishedEventId) {
      appliedStateEventId = latest.id;
    } else if (latest && latest.id !== appliedStateEventId) {
      if (failedStateId === latest.id) {
        emitPaused(
          "state",
          "The encrypted notification read/archive state could not be decrypted. Local controls still work, but cross-device state sync is paused.",
        );
        return;
      }
      try {
        const relayState = await decryptStateEvent(
          latest,
          resolvedSigner.signer,
        );
        if (
          stopped ||
          revision !== ownerRevision ||
          currentEvent(stateFilter(notificationPubkey))?.id !== latest.id
        ) {
          requestReconcile();
          return;
        }
        baseState = relayState;
        appliedStateEventId = latest.id;
        const rebased = replayUpdates(baseState, pendingUpdates);
        if (!stateEquals(rebased, readState$.getValue()))
          readState$.next(rebased);
      } catch (error) {
        if (stopped || revision !== ownerRevision) return;
        failedStateId = latest.id;
        emitPaused(
          "state",
          error instanceof Error
            ? `The encrypted notification state could not be decrypted: ${error.message}`
            : "The encrypted notification state could not be decrypted.",
        );
        return;
      }
    }

    emitReady();
    await flushPublish();
  }

  const relayScopeSub = notificationRelayScopeObservable(pubkey).subscribe(
    (scope) => {
      relayScope = scope;
      relayUrls$.next(scope.relays);
      requestReconcile();
    },
  );

  restartWarmOwner(scopeNotificationPubkey);

  return {
    state$,
    enqueue(update) {
      if (stopped) return;
      const previous = readState$.getValue();
      const next = update(previous);
      if (stateEquals(previous, next)) return;
      pendingUpdates.push(update);
      readState$.next(next);
      if (publishTimer) clearTimeout(publishTimer);
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        publishRequested = true;
        requestReconcile();
      }, PUBLISH_DEBOUNCE_MS);
      const current = state$.getValue();
      emitState({ ...current, pendingChanges: true });
    },
    retry() {
      if (stopped) return;
      selectionSync.retry();
      const restartCoverage = coverageBlocked;
      failedEnvelopeId = null;
      failedStateId = null;
      publishRequested = pendingUpdates.length > 0 || publishRequested;
      coverageBlocked = false;
      emitState({
        status: "checking",
        stage: scopeNotificationPubkey ? "state" : "envelope",
        message: "Retrying encrypted notification state sync...",
        pendingChanges: pendingUpdates.length > 0,
      });
      if (restartCoverage) restartWarmOwner(scopeNotificationPubkey);
      else requestReconcile();
    },
    enableRepoSelectionSync() {
      if (stopped) return;
      selectionSync.enable();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      selectionSync.stop();
      ownerRevision += 1;
      if (publishTimer) clearTimeout(publishTimer);
      relayScopeSub.unsubscribe();
      coverageChangesSub?.unsubscribe();
      coverage?.stop();
      relaySub?.unsubscribe();
      storeSub?.unsubscribe();
      relayUrls$.complete();
      state$.complete();
      evictNotificationSigner(pubkey);
    },
  };
}
