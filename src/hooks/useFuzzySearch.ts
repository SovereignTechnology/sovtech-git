import { useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";

/** Search a local collection while preserving its source order for empty queries. */
export function useFuzzySearch<T>(
  items: T[] | undefined,
  query: string,
  options: IFuseOptions<T>,
): T[] | undefined {
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;

  // Lists can update while browsing; only index them when a query needs it.
  // Depend on search activity so editing a nonempty query reuses the index.
  const fuse = useMemo(
    () => (items && searching ? new Fuse(items, options) : undefined),
    [items, options, searching],
  );

  return useMemo(() => {
    if (!items) return undefined;

    if (!searching) return items;

    return fuse?.search(trimmedQuery).map(({ item }) => item) ?? [];
  }, [fuse, items, searching, trimmedQuery]);
}
