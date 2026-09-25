import type { Filter } from "applesauce-core/helpers";
import { AppDataFactory } from "applesauce-common/factories";
import {
  getAppDataContent,
  isAppDataUnlocked,
  unlockAppData,
} from "applesauce-common/helpers/app-data";
import type { PrivateKeySigner } from "applesauce-signers/signers";
import type { NostrEvent } from "nostr-tools";
import {
  emptySelectionState,
  mergeSelectionStates,
  parseRepoSelectionState,
  REPO_SELECTION_D_TAG,
  type RepoSelectionState,
} from "@/lib/repoSelectionState";
import { NIP78_KIND } from "@/lib/notifications";
import { eventStore } from "@/services/nostr";
import {
  getRepoSelectionStore,
  type SelectionSyncStatus,
} from "./repoSelectionStore";

export function repoSelectionFilter(pubkey: string): Filter {
  return {
    kinds: [NIP78_KIND],
    authors: [pubkey],
    "#d": [REPO_SELECTION_D_TAG],
  } as Filter;
}

async function readSelectionState(event: NostrEvent, signer: PrivateKeySigner) {
  if (!isAppDataUnlocked(event)) await unlockAppData(event, signer);
  return parseRepoSelectionState(getAppDataContent<unknown>(event));
}

/**
 * Derived-key convergent app state. The notification owner supplies the exact
 * filter's warm coverage and signer; this controller never opens a relay query.
 * See docs/replaceable-preflight.md, "Repository selection state".
 */
export function startRepoSelectionSync(
  pubkey: string,
  requestReconcile: () => void,
) {
  const store = getRepoSelectionStore(pubkey);
  const release = store.acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishDue = false;
  let stopped = false;
  /** Sign/publish failures wait for a manual retry. */
  let failed = false;
  /** Decode failures latch on the winner and clear when a newer one arrives. */
  let failedRemoteId: string | undefined;
  let appliedId: string | undefined;
  let author: string | undefined;
  /**
   * Explicit, in-memory request to create the notification key. Persisted
   * scores never count as intent: they would turn every keyless session into
   * a standing bootstrap request. Cleared once a key exists or on stop.
   */
  let keyRequested = false;
  let remote = emptySelectionState();
  function schedule() {
    if (stopped || timer || publishDue) return;
    timer = setTimeout(() => {
      timer = undefined;
      publishDue = true;
      requestReconcile();
    }, 3 * 60_000);
  }
  // Every store change reconciles; only a local difference from the remote
  // winner starts the batch window, so merging another device's event or a
  // sibling tab's cache never shortens a later click's three minutes.
  const unsubscribe = store.subscribe(requestReconcile);
  function current(author: string) {
    return eventStore.getByFilters(repoSelectionFilter(author))[0] as
      | NostrEvent
      | undefined;
  }
  return {
    availability(status: SelectionSyncStatus) {
      if (!failed && failedRemoteId === undefined)
        store.setStatus({
          ...status,
          message:
            status.status === "ready" || status.status === "local"
              ? status.message
              : `Repository ordering sync is waiting for the shared notification key and relay checks. ${status.message}`,
        });
    },
    /** Whether the user asked this session to create the notification key. */
    keyRequested: () => keyRequested,
    /** Ask the notification owner to create the key and publish right away. */
    enable() {
      if (stopped) return;
      keyRequested = true;
      publishDue = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      store.setStatus({
        status: "checking",
        message: "Enabling repository ordering sync…",
      });
      requestReconcile();
    },
    retry() {
      failed = false;
      failedRemoteId = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
      publishDue = true;
      store.setStatus({
        status: "checking",
        message: "Retrying repository ordering sync…",
      });
    },
    async reconcile(signer: PrivateKeySigner, isCurrent: () => boolean) {
      if (stopped || failed) return;
      try {
        const nextAuthor = await signer.getPublicKey();
        if (!isCurrent()) return;
        keyRequested = false;
        if (nextAuthor !== author) {
          author = nextAuthor;
          appliedId = undefined;
          remote = emptySelectionState();
        }
        const latest = current(author);
        if (latest && latest.id === failedRemoteId) {
          store.setStatus({
            status: "paused",
            message:
              "Repository ordering is saved locally, but the synced copy could not be read. Sync resumes when a newer copy arrives.",
          });
          return;
        }
        if (latest?.id !== appliedId) {
          let content: RepoSelectionState;
          try {
            content = latest
              ? await readSelectionState(latest, signer)
              : emptySelectionState();
          } catch (error) {
            if (stopped || !isCurrent()) return;
            // A bad event from one device must not pause every other device
            // for good: the next winner is decoded on its own merits.
            failedRemoteId = latest?.id;
            store.setStatus({
              status: "paused",
              message: `Repository ordering is saved locally, but the synced copy could not be read. ${error instanceof Error ? error.message : "Unable to read synced repository ordering."}`,
            });
            return;
          }
          if (!isCurrent() || current(author)?.id !== latest?.id) {
            requestReconcile();
            return;
          }
          failedRemoteId = undefined;
          remote = content;
          appliedId = latest?.id;
          store.merge(remote);
        }
        const now = Date.now();
        const snapshot = mergeSelectionStates(
          store.getSnapshot(),
          emptySelectionState(),
          now,
        );
        const normalizedRemote = mergeSelectionStates(
          remote,
          emptySelectionState(),
          now,
        );
        const needsPublish =
          JSON.stringify(snapshot) !== JSON.stringify(normalizedRemote);
        if (!needsPublish) {
          if (timer) clearTimeout(timer);
          timer = undefined;
          publishDue = false;
          store.setStatus({
            status: "ready",
            message: "Repository ordering is synced.",
          });
          return;
        }
        if (!publishDue) {
          // Batch from the first pending change, so continued use cannot
          // postpone publication indefinitely.
          if (!timer) schedule();
          store.setStatus({
            status: "checking",
            message: "Repository ordering changes are queued for sync.",
          });
          return;
        }
        // The derived key signs without prompting, so every pass signs the
        // current snapshot afresh rather than caching a signed event.
        const signed = await AppDataFactory.create(
          REPO_SELECTION_D_TAG,
          snapshot,
        )
          .as(signer)
          .created(
            Math.max(Math.floor(now / 1_000), (latest?.created_at ?? 0) + 1),
          )
          .encryptedContent(author, JSON.stringify(snapshot), "nip44")
          .sign();
        const { outboxStore } = await import("./outbox");
        if (!isCurrent() || current(author)?.id !== latest?.id) {
          requestReconcile();
          return;
        }
        await outboxStore.publish(
          signed,
          [`outbox:${pubkey}`, "fallback-relays"],
          { hidden: true },
        );
        // The durable outbox now owns delivery, so record the publication even
        // if coverage flipped meanwhile; otherwise the same snapshot is signed
        // and handed to the outbox again on the next pass.
        if (stopped) return;
        remote = snapshot;
        appliedId = signed.id;
        publishDue = false;
        // Preserve a competitor that arrived during the asynchronous handoff
        // before adding our signed copy can evict it from the replaceable store.
        const arrived = current(author);
        if (arrived && arrived.id !== latest?.id && arrived.id !== signed.id) {
          try {
            const content = await readSelectionState(arrived, signer);
            if (stopped) return;
            store.merge(content);
          } catch (error) {
            if (stopped) return;
            failedRemoteId = arrived.id;
            store.setStatus({
              status: "paused",
              message: `Repository ordering is saved locally, but the synced copy could not be read. ${error instanceof Error ? error.message : "Unable to read synced repository ordering."}`,
            });
            requestReconcile();
            return;
          }
        }
        // If another winner arrived during decryption, leave it for the next
        // reconciliation instead of overwriting an unread snapshot.
        if (current(author)?.id === arrived?.id) eventStore.add(signed);
        store.setStatus({
          status: "ready",
          message: "Repository ordering is synced.",
        });
        requestReconcile();
      } catch (error) {
        if (stopped || !isCurrent()) return;
        failed = true;
        store.setStatus({
          status: "paused",
          message: `Repository ordering is saved locally, but sync is paused. ${error instanceof Error ? error.message : "Unable to sync repository ordering."}`,
        });
      }
    },
    stop() {
      stopped = true;
      keyRequested = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
      release();
    },
  };
}
