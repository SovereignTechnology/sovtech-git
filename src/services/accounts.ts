import { AccountManager, type SerializedAccount } from "applesauce-accounts";
import {
  AmberClipboardAccount,
  NostrConnectAccount,
} from "applesauce-accounts/accounts";
import { registerAndroidAccounts } from "applesauce-accounts/accounts/android-native-account";
import { applySignerNudge } from "@/hooks/useLoginActions";
import { switchMap, distinctUntilChanged, map } from "rxjs/operators";
import { of } from "rxjs";
// Import pool to ensure NostrConnectSigner.pool is set before fromJSON runs,
// so restored NostrConnectAccount signers can be constructed successfully.
import {
  watchUserMailboxesForOutboxReResolve,
  eventStore,
} from "@/services/nostr";
import { startUserIdentitySubscription } from "@/services/userIdentitySubscription";
import { startPrivateGitRelaySession } from "@/services/privateGitRelays";
import { MailboxesModel } from "applesauce-core/models";

/**
 * Global AccountManager instance for multi-account support.
 * Handles adding, removing, and switching between Nostr accounts.
 */
export const accounts = new AccountManager();

// Register the common web accounts plus persisted native Android signers.
registerAndroidAccounts(accounts);
accounts.registerType(AmberClipboardAccount);

// Suppresses local localStorage writes during a cross-tab sync so the
// persistence subscriptions below do not echo the incoming state back to
// storage, which would overwrite the other tab's authoritative values and
// trigger spurious storage events in all other open tabs.
let isApplyingCrossTabSync = false;

// Restore persisted accounts then wire up persistence subscriptions.
// Subscriptions are set up AFTER restoration so the initial active$.emit
// of undefined does not overwrite the stored active account id.
(async () => {
  try {
    const savedAccounts = localStorage.getItem("accounts");
    if (savedAccounts) {
      await accounts.fromJSON(JSON.parse(savedAccounts), true);

      // Re-open relay subscriptions for any restored NostrConnect accounts.
      // fromJSON reconstructs the signer with all credentials but does not
      // re-establish the NIP-46 relay subscription or mark the session as
      // connected. We call open() + set isConnected so signing works
      // immediately after a page refresh without a new connect handshake.
      for (const account of accounts.accounts$.getValue()) {
        if (account instanceof NostrConnectAccount) {
          account.signer.open().catch((err) => {
            console.warn("Failed to re-open NostrConnect session:", err);
          });
          account.signer.isConnected = true;
        }
        // Apply nudge wrapper to all restored accounts that benefit from it.
        applySignerNudge(account);
      }
    }
  } catch (error) {
    console.error("Failed to restore accounts from localStorage:", error);
  }

  try {
    const lastActive = localStorage.getItem("active-account");
    if (lastActive) accounts.setActive(lastActive);
  } catch (error) {
    console.error("Failed to restore last active account:", error);
  }

  // Persist accounts whenever they change
  accounts.accounts$.subscribe(() => {
    if (isApplyingCrossTabSync) return;
    try {
      localStorage.setItem("accounts", JSON.stringify(accounts.toJSON(true)));
    } catch (error) {
      console.error("Failed to persist accounts:", error);
    }
  });

  // Persist active account id whenever it changes
  accounts.active$.subscribe((account) => {
    if (isApplyingCrossTabSync) return;
    localStorage.setItem("active-account", account?.id ?? "");
  });

  // Watch the active account's NIP-65 relay list and re-resolve relay groups
  // for any pending outbox items when it changes. Tear down the previous
  // subscription when the account switches.
  let unwatchMailboxes: (() => void) | null = null;
  accounts.active$.subscribe((account) => {
    unwatchMailboxes?.();
    unwatchMailboxes = null;
    if (account?.pubkey) {
      unwatchMailboxes = watchUserMailboxesForOutboxReResolve(account.pubkey);
    }
  });

  // Keep a persistent subscription open for the active user's replaceable
  // personal-singleton events on the union of their
  // outbox relays and lookup/index relays.
  //
  // Strategy: whenever the active account changes OR their NIP-65 outbox relay
  // list changes, tear down the previous subscription and start a fresh one on
  // the updated relay set. This ensures all user replaceable events are always
  // as fresh as possible — the prerequisite for safe replaceable event edits.
  let stopIdentitySub: (() => void) | null = null;
  let stopPrivateGitRelays: (() => void) | null = null;

  accounts.active$
    .pipe(
      switchMap((account) => {
        if (!account?.pubkey) return of(null);
        const pubkey = account.pubkey;
        return eventStore.model(MailboxesModel, pubkey).pipe(
          map((mailboxes) => ({
            account,
            outboxes: mailboxes?.outboxes ?? [],
          })),
          // Only restart when the serialised outbox list actually changes
          distinctUntilChanged(
            (a, b) =>
              a.account.id === b.account.id &&
              JSON.stringify([...a.outboxes].sort()) ===
                JSON.stringify([...b.outboxes].sort()),
          ),
        );
      }),
    )
    .subscribe((value) => {
      // Tear down the previous identity subscription before starting a new one
      stopIdentitySub?.();
      stopIdentitySub = null;
      stopPrivateGitRelays?.();
      stopPrivateGitRelays = null;
      if (value) {
        stopIdentitySub = startUserIdentitySubscription(
          value.account.pubkey,
          value.outboxes,
        );
        stopPrivateGitRelays = startPrivateGitRelaySession(
          value.account,
          value.outboxes,
        );
      }
    });

  // Read both current values together: a queued storage event may describe an
  // older selection, or the selected account may have just been added. Applying
  // this synchronously also prevents account restoration racing a later switch.
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (
      event.key !== "accounts" &&
      event.key !== "active-account" &&
      event.key !== null
    )
      return;

    isApplyingCrossTabSync = true;
    try {
      const savedAccounts: SerializedAccount<unknown, unknown>[] = JSON.parse(
        localStorage.getItem("accounts") ?? "[]",
      );
      const activeId = localStorage.getItem("active-account");
      const savedIds = new Set(savedAccounts.map((account) => account.id));
      const existingIds = new Set(
        accounts.accounts.map((account) => account.id),
      );

      // fromJSON adds missing accounts; it does not remove existing ones.
      // Keep existing instances (and their live signer connections) intact.
      accounts.fromJSON(
        savedAccounts.filter((account) => !existingIds.has(account.id)),
        true,
      );
      for (const account of accounts.accounts) {
        if (!savedIds.has(account.id)) {
          accounts.removeAccount(account.id);
        } else if (!existingIds.has(account.id)) {
          if (account instanceof NostrConnectAccount) {
            account.signer.open().catch((err: unknown) => {
              console.warn(
                "Cross-tab sync: failed to open NostrConnect session:",
                err,
              );
            });
            account.signer.isConnected = true;
          }
          applySignerNudge(account);
        }
      }

      // Account IDs distinguish signers even when they share a public key.
      // Never echo this selection into storage: newer changes may already be
      // queued in another tab, and replaying older values causes switch loops.
      if (activeId && accounts.getAccount(activeId)) {
        accounts.setActive(activeId);
      } else if (accounts.getActive()) {
        accounts.clearActive();
      }
    } catch (err) {
      console.error("Cross-tab accounts sync failed:", err);
    } finally {
      isApplyingCrossTabSync = false;
    }
  });
})();
