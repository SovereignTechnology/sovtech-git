import { EventStore, type IEventStore } from "applesauce-core";
import {
  addSeenRelay,
  fakeVerifyEvent,
  getSeenRelays,
} from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { Subscription } from "rxjs";
import { RelayEventPresence } from "./relayEventPresence";

/** A disposable read projection. Relay loading, publishing and persistence
 * retain one canonical store. Switching policy changes the projection's
 * contents, so existing models re-evaluate without remounting the page.
 */
export class CuratedEventStore {
  readonly store: IEventStore;
  private readonly view = new EventStore({
    keepDeleted: false,
    keepExpired: false,
    keepOldVersions: false,
  });
  private subscriptions = new Subscription();
  private connected = false;
  private relays: readonly string[] = [];
  private expanded = false;
  private disposed = false;
  private pending = new Set<string>();
  private scheduled = false;

  constructor(
    private readonly source: IEventStore,
    private readonly presence: RelayEventPresence,
  ) {
    // Admission and verified deletion handling belong to the canonical store.
    this.view.verifyEvent = fakeVerifyEvent;
    this.store = new Proxy(this.view, {
      get: (target, key) => {
        if (key === "add" || key === "remove" || key === "update")
          return source[key].bind(source);
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Attach only after React commits the owner, not during render. A StrictMode
   * effect re-attachment keeps the same store; a real unmount disposes it.
   */
  connect(): () => void {
    this.connected = true;
    this.subscriptions = new Subscription();
    const changed = (event: NostrEvent) => this.enqueue(event.id);
    this.subscriptions.add(this.source.insert$.subscribe(changed));
    this.subscriptions.add(this.source.update$.subscribe(changed));
    this.subscriptions.add(this.source.remove$.subscribe(changed));
    this.subscriptions.add(
      this.presence.changes$.subscribe((ids) => {
        for (const id of ids) this.enqueue(id);
      }),
    );
    this.refresh();
    return () => {
      this.connected = false;
      this.subscriptions.unsubscribe();
      this.pending.clear();
      queueMicrotask(() => {
        if (!this.connected) this.dispose();
      });
    };
  }

  setPolicy(relays: readonly string[], expanded: boolean): void {
    if (
      expanded === this.expanded &&
      relays.length === this.relays.length &&
      relays.every((relay, index) => relay === this.relays[index])
    )
      return;
    this.relays = [...relays];
    this.expanded = expanded;
    this.refresh();
  }

  private allowed(event: NostrEvent): boolean {
    // Identity/configuration and addressable metadata keep their normal trust
    // resolvers. Signed deletions remain global guards: curation must never
    // resurrect something the canonical store has deleted. Addressable CI
    // results are collaboration content and still require relay evidence.
    return (
      this.expanded ||
      event.kind === 0 ||
      event.kind === 3 ||
      event.kind === 5 ||
      (event.kind >= 10000 && event.kind !== 39842) ||
      this.presence.has(event.id, this.relays) ||
      this.presence.hasCached(event.id, this.relays)
    );
  }

  private enqueue(id: string): void {
    this.pending.add(id);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.disposed || !this.connected) return;
      const ids = this.pending;
      this.pending = new Set();
      for (const id of ids) this.reconcile(id, true);
    });
  }

  private reconcile(id: string, update = false): void {
    const event = this.source.getEvent(id);
    if (!event || !this.allowed(event)) {
      this.view.remove(id);
      return;
    }
    if (this.view.hasEvent(id)) {
      if (!update) return;
      const copy = this.view.getEvent(id)!;
      let changed = false;
      for (const relay of getSeenRelays(event) ?? []) {
        if (getSeenRelays(copy)?.has(relay)) continue;
        addSeenRelay(copy, relay);
        changed = true;
      }
      // Event bodies are immutable. Reconfirming membership must not rebuild
      // every model when this copy already has the same presentation metadata.
      if (changed) this.view.update(copy);
      return;
    }
    // Do not share EventStoreSymbol or memoized cast/model values across stores.
    const copy: NostrEvent = {
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    };
    for (const relay of getSeenRelays(event) ?? []) addSeenRelay(copy, relay);
    this.view.add(copy);
  }

  private refresh(): void {
    for (const event of this.source.getByFilters({})) this.reconcile(event.id);
    for (const event of this.view.getByFilters({}))
      if (!this.source.hasEvent(event.id)) this.view.remove(event.id);
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.unsubscribe();
    this.pending.clear();
    this.view.dispose();
  }
}
