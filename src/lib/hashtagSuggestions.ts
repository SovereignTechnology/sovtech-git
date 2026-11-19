import type { ResolvedIssueLite, ResolvedPRLite } from "@/lib/nip34";

export type HashtagItem = (ResolvedIssueLite | ResolvedPRLite) & {
  referenceType: "issue" | "pr";
};

/** Use resolved repository metadata, including authorised status/label edits. */
export function getHashtagSuggestions(
  query: string,
  issues: readonly ResolvedIssueLite[] = [],
  prs: readonly ResolvedPRLite[] = [],
) {
  const term = query.toLocaleLowerCase();
  const items: HashtagItem[] = [
    ...issues.map((item) => ({ ...item, referenceType: "issue" as const })),
    ...prs.map((item) => ({ ...item, referenceType: "pr" as const })),
  ].filter((item) => item.status !== "deleted");
  const labelCounts = new Map<string, number>();
  for (const item of items) {
    for (const label of item.labels) {
      // Only offer labels that can be inserted as a single hashtag.
      if (!/^[\p{L}\p{N}\p{M}]+$/u.test(label)) continue;
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }
  const labels = [...labelCounts.keys()]
    .filter((label) => label.toLocaleLowerCase().includes(term))
    .sort(
      (a, b) =>
        Number(b.toLocaleLowerCase() === term) -
          Number(a.toLocaleLowerCase() === term) ||
        (labelCounts.get(b) ?? 0) - (labelCounts.get(a) ?? 0) ||
        a.localeCompare(b),
    )
    .slice(0, 3);
  const exactId = (item: HashtagItem) =>
    item.id === term || item.id.slice(0, 8) === term;
  const matches = items
    .filter(
      (item) =>
        !term ||
        item.id.startsWith(term) ||
        item.currentSubject.toLocaleLowerCase().includes(term),
    )
    .sort(
      (a, b) =>
        Number(exactId(b)) - Number(exactId(a)) ||
        Number(b.status === "open") - Number(a.status === "open") ||
        b.lastActivityAt - a.lastActivityAt ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 6);
  return { labels, items: matches };
}
