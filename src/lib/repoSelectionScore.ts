/**
 * Decaying selection scores for ranking the dashboard's "My repositories" list.
 *
 * Scores retain 90% of their value each week. Because decay is exponential,
 * only a score and reference time are needed; time passing alone never
 * requires a write. Click weighting lives in repoSelectionState.ts.
 */

import type { ResolvedRepo } from "@/lib/nip34";

export const SELECTION_HALF_LIFE_MS =
  (7 * 24 * 60 * 60 * 1000 * Math.log(0.5)) / Math.log(0.9);

/** Scores below this are inactive on read and dropped on the next write. */
const PRUNE_BELOW = 0.01;

export interface SelectionEntry {
  score: number;
  at: number;
}
/** Keyed by repository coordinate (`30617:<pubkey>:<dTag>`). */
export type SelectionScores = Record<string, SelectionEntry>;

export function decayedScore(
  entry: SelectionEntry | undefined,
  now: number,
): number {
  if (!entry) return 0;
  const age = Math.max(0, now - entry.at);
  const score = entry.score * 0.5 ** (age / SELECTION_HALF_LIFE_MS);
  return score < PRUNE_BELOW ? 0 : score;
}

/** Usage first; equal scores follow pin order, then recent repository activity. */
export function compareBySelection(
  scores: SelectionScores,
  now: number,
  pinnedCoordinates: readonly string[] = [],
) {
  const pinOrder = new Map<string, number>();
  pinnedCoordinates.forEach((coordinate, index) => {
    if (!pinOrder.has(coordinate)) pinOrder.set(coordinate, index);
  });
  return (
    a: Pick<ResolvedRepo, "selectedCoordinate" | "updatedAt">,
    b: Pick<ResolvedRepo, "selectedCoordinate" | "updatedAt">,
  ): number =>
    decayedScore(scores[b.selectedCoordinate], now) -
      decayedScore(scores[a.selectedCoordinate], now) ||
    (pinOrder.get(a.selectedCoordinate) ?? pinnedCoordinates.length) -
      (pinOrder.get(b.selectedCoordinate) ?? pinnedCoordinates.length) ||
    b.updatedAt - a.updatedAt;
}
