import {
  EventCast,
  type CastRefEventStore,
} from "applesauce-common/casts/cast";
import { getOrComputeCachedValue, getTagValue } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import {
  DEFAULT_REPO_LIST_SORT,
  isRepoListSort,
  type RepoListSort,
} from "@/lib/repoListSort";

export const PREFERENCES_KIND = 30078;
export const PREFERENCES_IDENTIFIER = "gitworkshop-preferences";
const ContentSymbol = Symbol.for("gitworkshop-preferences-content");

export class GitWorkshopPreferences extends EventCast {
  constructor(event: NostrEvent, store: CastRefEventStore) {
    if (
      event.kind !== PREFERENCES_KIND ||
      getTagValue(event, "d") !== PREFERENCES_IDENTIFIER
    ) {
      throw new Error("Invalid GitWorkshop preferences event");
    }
    super(event, store);
  }

  get data(): Record<string, unknown> {
    return getOrComputeCachedValue(this.event, ContentSymbol, () => {
      const value: unknown = JSON.parse(this.event.content);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Saved GitWorkshop preferences are not a JSON object.");
      }
      return value as Record<string, unknown>;
    });
  }

  get listSort(): RepoListSort {
    if (isRepoListSort(this.data.listSort)) return this.data.listSort;
    // Preserve defaults written before PR lists shared this setting.
    return isRepoListSort(this.data.issueSort)
      ? this.data.issueSort
      : DEFAULT_REPO_LIST_SORT;
  }
}
