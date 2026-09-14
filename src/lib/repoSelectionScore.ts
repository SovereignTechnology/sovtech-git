/**
 * Decaying selection scores for ranking the dashboard's "My repositories" list.
 *
 * Each selection adds 1 to a repo's score, and the score halves every
 * SELECTION_HALF_LIFE_MS. Because decay is exponential, only the score and the
 * time it was last updated need storing — it is decayed forward on read.
 */

import { z } from "zod";
import type { ResolvedRepo } from "@/lib/nip34";

export const SELECTION_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Entries that have decayed below this are dropped on the next write. */
const PRUNE_BELOW = 0.01;

const entrySchema = z.object({
  score: z.number().finite().nonnegative(),
  at: z.number().finite(),
});
const scoresSchema = z.record(z.string(), entrySchema);

export type SelectionEntry = z.infer<typeof entrySchema>;
/** Keyed by repository coordinate (`30617:<pubkey>:<dTag>`). */
export type SelectionScores = Record<string, SelectionEntry>;

export function decayedScore(
  entry: SelectionEntry | undefined,
  now: number,
): number {
  if (!entry) return 0;
  const age = Math.max(0, now - entry.at);
  return entry.score * 0.5 ** (age / SELECTION_HALF_LIFE_MS);
}

export function recordSelection(
  scores: SelectionScores,
  coordinate: string,
  now: number,
): SelectionScores {
  const next: SelectionScores = {};
  for (const [key, entry] of Object.entries(scores)) {
    if (key !== coordinate && decayedScore(entry, now) >= PRUNE_BELOW) {
      next[key] = entry;
    }
  }
  next[coordinate] = {
    score: decayedScore(scores[coordinate], now) + 1,
    at: now,
  };
  return next;
}

export function parseSelectionScores(raw: string | null): SelectionScores {
  if (raw === null) return {};
  try {
    const parsed = scoresSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Most-selected first; ties (including never-selected repos) by recent activity. */
export function compareBySelection(scores: SelectionScores, now: number) {
  return (
    a: Pick<ResolvedRepo, "selectedCoordinate" | "updatedAt">,
    b: Pick<ResolvedRepo, "selectedCoordinate" | "updatedAt">,
  ): number =>
    decayedScore(scores[b.selectedCoordinate], now) -
      decayedScore(scores[a.selectedCoordinate], now) ||
    b.updatedAt - a.updatedAt;
}
