import { Subject } from "rxjs";
import { normalizeUrl } from "./url";

/** Session evidence, not a permanent relay tag or a promise of future retention.
 * Disk-cache hits never call observe. Completed reconciliations can withdraw
 * evidence; failed/cancelled negotiations cannot establish absence.
 */
export class RelayEventPresence {
  readonly changes$ = new Subject<ReadonlySet<string>>();
  private revision = 0;
  private cached = new Set<string>();
  private evidence = new Map<
    string,
    Map<string, { present: boolean; revision: number }>
  >();

  begin(): number {
    return ++this.revision;
  }

  has(id: string, relays: readonly string[]): boolean {
    const sources = this.evidence.get(id);
    return relays.some(
      (relay) => sources?.get(normalizeUrl(relay))?.present === true,
    );
  }

  /** Legacy cache contents are accepted for display, not fresh relay evidence.
   * A successful absence result from every current relay withdraws that fallback.
   */
  acceptCached(ids: Iterable<string>): void {
    const changed = new Set<string>();
    for (const id of ids) {
      if (!this.cached.has(id)) {
        this.cached.add(id);
        changed.add(id);
      }
    }
    if (changed.size) this.changes$.next(changed);
  }

  hasCached(id: string, relays: readonly string[]): boolean {
    return (
      this.cached.has(id) &&
      relays.length > 0 &&
      !relays.every(
        (relay) =>
          this.evidence.get(id)?.get(normalizeUrl(relay))?.present === false,
      )
    );
  }

  /** Absence needs a completed result from every relay in the current scope. */
  isAbsent(id: string, relays: readonly string[]): boolean {
    return (
      relays.length > 0 &&
      relays.every(
        (relay) =>
          this.evidence.get(id)?.get(normalizeUrl(relay))?.present === false,
      )
    );
  }

  hasAny(id: string): boolean {
    return [...(this.evidence.get(id)?.values() ?? [])].some(
      (source) => source.present,
    );
  }

  observe(id: string, relay: string): void {
    const changed = this.write(id, normalizeUrl(relay), true);
    if (changed) this.changes$.next(new Set([id]));
  }

  /** A completed negotiation advertised these IDs; the bodies may come from
   * another relay. Preserve newer evidence rather than recording a fresh receipt.
   */
  confirm(relay: string, ids: readonly string[], started: number): void {
    this.reconcile(relay, ids, new Set(ids), started);
  }

  /** inventory is the immutable local set supplied to this negotiation, not a
   * later store query. Do not overwrite evidence learned after it began.
   */
  reconcile(
    relay: string,
    inventory: readonly string[],
    present: ReadonlySet<string>,
    started: number,
  ): void {
    relay = normalizeUrl(relay);
    const changed = new Set<string>();
    for (const id of inventory) {
      if ((this.evidence.get(id)?.get(relay)?.revision ?? 0) > started)
        continue;
      if (this.write(id, relay, present.has(id), started)) changed.add(id);
    }
    if (changed.size) this.changes$.next(changed);
  }

  private write(
    id: string,
    relay: string,
    present: boolean,
    revision = ++this.revision,
  ): boolean {
    let sources = this.evidence.get(id);
    if (!sources) this.evidence.set(id, (sources = new Map()));
    const changed = sources.get(relay)?.present !== present;
    sources.set(relay, { present, revision });
    return changed;
  }
}

export const relayEventPresence = new RelayEventPresence();
