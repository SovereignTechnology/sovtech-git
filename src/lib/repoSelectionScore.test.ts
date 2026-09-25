import { describe, expect, test } from "vitest";
import {
  SELECTION_HALF_LIFE_MS,
  compareBySelection,
  decayedScore,
} from "./repoSelectionScore";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function repo(dTag: string, updatedAt: number) {
  return { selectedCoordinate: `30617:pk:${dTag}`, updatedAt };
}

// ---------------------------------------------------------------------------
// decayedScore
// ---------------------------------------------------------------------------

describe("decayedScore", () => {
  test("returns 0 for a missing entry", () => {
    expect(decayedScore(undefined, NOW)).toBe(0);
  });

  test("halves after one half-life", () => {
    const entry = { score: 4, at: NOW - SELECTION_HALF_LIFE_MS };
    expect(decayedScore(entry, NOW)).toBeCloseTo(2);
  });

  test("does not grow for timestamps in the future", () => {
    expect(decayedScore({ score: 3, at: NOW + DAY }, NOW)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// compareBySelection
// ---------------------------------------------------------------------------

describe("compareBySelection", () => {
  test("ranks higher scores first", () => {
    const scores = { "30617:pk:picked": { score: 1, at: NOW } };
    const sorted = [repo("active", 200), repo("picked", 100)].sort(
      compareBySelection(scores, NOW),
    );
    expect(sorted.map((r) => r.selectedCoordinate)).toEqual([
      "30617:pk:picked",
      "30617:pk:active",
    ]);
  });

  test("falls back to recent activity when scores are equal", () => {
    const sorted = [repo("older", 100), repo("newer", 200)].sort(
      compareBySelection({}, NOW),
    );
    expect(sorted.map((r) => r.selectedCoordinate)).toEqual([
      "30617:pk:newer",
      "30617:pk:older",
    ]);
  });

  test("a repo picked often long ago can rank below one picked recently", () => {
    const scores = {
      "30617:pk:stale": { score: 5, at: NOW - 180 * DAY },
      "30617:pk:fresh": { score: 1, at: NOW },
    };
    const sorted = [repo("stale", 200), repo("fresh", 100)].sort(
      compareBySelection(scores, NOW),
    );
    expect(sorted.map((r) => r.selectedCoordinate)).toEqual([
      "30617:pk:fresh",
      "30617:pk:stale",
    ]);
  });
});
