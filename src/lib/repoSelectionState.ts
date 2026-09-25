import { z } from "zod";
import { decayedScore, type SelectionScores } from "./repoSelectionScore";

export const REPO_SELECTION_D_TAG = "gitworkshop-repo-selections-v1";
export const CLICK_RECOVERY_MS = 5 * 60 * 1000;
const coordinateSchema = z.string().regex(/^30617:[0-9a-f]{64}:.*$/s);
const deviceSchema = z.string().regex(/^[0-9a-f]{24}$/);
const integer = z.number().int().nonnegative().safe();
/** Hundredths of a credit and the Unix seconds of the device's last click. */
const contributionSchema = z.tuple([integer, integer]);
const stateSchema = z
  .object({
    v: z.literal(3),
    r: z.record(coordinateSchema, z.record(deviceSchema, contributionSchema)),
  })
  .strict();
export type RepoSelectionState = z.infer<typeof stateSchema>;
type Contribution = z.infer<typeof contributionSchema>;
export const emptySelectionState = (): RepoSelectionState => ({ v: 3, r: {} });

/** Unknown schemas fail closed rather than replacing state with nothing. */
export function parseRepoSelectionState(value: unknown): RepoSelectionState {
  // Version 2 only existed in unreleased builds; its data is discarded.
  if (z.object({ v: z.literal(2) }).safeParse(value).success)
    return emptySelectionState();
  return stateSchema.parse(value);
}

function remainingCredits(
  entry: Contribution | undefined,
  now: number,
): number {
  return entry
    ? decayedScore({ score: entry[0] / 100, at: entry[1] * 1000 }, now)
    : 0;
}

/**
 * Repeated snapshots merge per device, never by adding remote totals. A
 * device's last-click time only moves forward, so the later write wins; the
 * same second keeps the higher score, which already includes the earlier
 * click's credit.
 */
export function mergeSelectionStates(
  a: RepoSelectionState,
  b: RepoSelectionState,
  now: number,
): RepoSelectionState {
  const next = emptySelectionState();
  for (const coordinate of [
    ...new Set([...Object.keys(a.r), ...Object.keys(b.r)]),
  ].sort()) {
    const left = a.r[coordinate] ?? {};
    const right = b.r[coordinate] ?? {};
    const devices: Record<string, Contribution> = {};
    for (const device of [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].sort()) {
      const x =
        remainingCredits(left[device], now) > 0 ? left[device] : undefined;
      const y =
        remainingCredits(right[device], now) > 0 ? right[device] : undefined;
      const entry = !x
        ? y
        : !y
          ? x
          : x[1] !== y[1]
            ? x[1] > y[1]
              ? x
              : y
            : x[0] >= y[0]
              ? x
              : y;
      if (entry) devices[device] = entry;
    }
    if (Object.keys(devices).length) next.r[coordinate] = devices;
  }
  return next;
}

/** Every visit counts: 0.10 for immediate repeats, rising to 1.00 after five minutes. */
export function clickCreditHundredths(
  lastClick: number | undefined,
  now: number,
): number {
  if (lastClick === undefined) return 100;
  const elapsed = Math.max(0, now - lastClick);
  return Math.round(10 + 90 * Math.min(1, elapsed / CLICK_RECOVERY_MS));
}

/** The stored reference time doubles as the device's last click on the repository. */
export function selectRepository(
  state: RepoSelectionState,
  device: string,
  coordinate: string,
  now: number,
): RepoSelectionState {
  if (!coordinateSchema.safeParse(coordinate).success) return state;
  const previous = state.r[coordinate]?.[device];
  const entry: Contribution = [
    Math.round(remainingCredits(previous, now) * 100) +
      clickCreditHundredths(previous && previous[1] * 1000, now),
    Math.max(Math.floor(now / 1000), previous?.[1] ?? 0),
  ];
  return mergeSelectionStates(
    state,
    { v: 3, r: { [coordinate]: { [device]: entry } } },
    now,
  );
}

export function selectionScores(
  state: RepoSelectionState,
  now: number,
): SelectionScores {
  const scores: SelectionScores = {};
  for (const [coordinate, devices] of Object.entries(state.r)) {
    const score = Object.values(devices).reduce(
      (sum, entry) => sum + remainingCredits(entry, now),
      0,
    );
    if (score > 0) scores[coordinate] = { score, at: now };
  }
  return scores;
}
