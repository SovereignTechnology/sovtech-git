import { describe, expect, test } from "vitest";
import {
  SELECTION_HALF_LIFE_MS,
  compareBySelection,
  decayedScore,
  parseSelectionScores,
  recordSelection,
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
// recordSelection
// ---------------------------------------------------------------------------

describe("recordSelection", () => {
  test("adds 1 on top of the decayed score", () => {
    const scores = {
      "30617:pk:a": { score: 2, at: NOW - SELECTION_HALF_LIFE_MS },
    };
    const next = recordSelection(scores, "30617:pk:a", NOW);
    expect(next["30617:pk:a"].score).toBeCloseTo(2);
    expect(next["30617:pk:a"].at).toBe(NOW);
  });

  test("creates an entry for a new coordinate", () => {
    expect(recordSelection({}, "30617:pk:a", NOW)).toEqual({
      "30617:pk:a": { score: 1, at: NOW },
    });
  });

  test("prunes entries that have decayed to almost nothing", () => {
    const scores = {
      "30617:pk:old": { score: 1, at: NOW - 365 * DAY },
      "30617:pk:recent": { score: 1, at: NOW - DAY },
    };
    const next = recordSelection(scores, "30617:pk:a", NOW);
    expect(Object.keys(next).sort()).toEqual(["30617:pk:a", "30617:pk:recent"]);
  });
});

// ---------------------------------------------------------------------------
// parseSelectionScores
// ---------------------------------------------------------------------------

describe("parseSelectionScores", () => {
  test("returns {} for null, invalid JSON, or the wrong shape", () => {
    expect(parseSelectionScores(null)).toEqual({});
    expect(parseSelectionScores("{not json")).toEqual({});
    expect(parseSelectionScores("[1,2]")).toEqual({});
    expect(parseSelectionScores('{"a":{"score":"x","at":1}}')).toEqual({});
  });

  test("parses valid scores", () => {
    const raw = JSON.stringify({ "30617:pk:a": { score: 1.5, at: NOW } });
    expect(parseSelectionScores(raw)).toEqual({
      "30617:pk:a": { score: 1.5, at: NOW },
    });
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
      "30617:pk:stale": { score: 5, at: NOW - 60 * DAY },
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
