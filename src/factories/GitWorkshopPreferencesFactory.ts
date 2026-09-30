import { EventFactory } from "applesauce-core/factories";
import type { NostrEvent } from "nostr-tools";
import {
  PREFERENCES_IDENTIFIER,
  PREFERENCES_KIND,
} from "@/casts/GitWorkshopPreferences";
import type { RepoListSort } from "@/lib/repoListSort";

export class GitWorkshopPreferencesFactory extends EventFactory {
  static create(
    previous: NostrEvent | undefined,
    data: Record<string, unknown>,
    listSort: RepoListSort,
  ) {
    return new GitWorkshopPreferencesFactory((resolve) =>
      resolve({
        kind: PREFERENCES_KIND,
        created_at: Math.max(
          Math.floor(Date.now() / 1000),
          (previous?.created_at ?? 0) + 1,
        ),
        tags: previous?.tags ?? [["d", PREFERENCES_IDENTIFIER]],
        content: JSON.stringify({ ...data, listSort }),
      }),
    );
  }
}
