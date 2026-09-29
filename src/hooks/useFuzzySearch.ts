import { useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";

/** Search a local collection while preserving its source order for empty queries. */
export function useFuzzySearch<T>(
  items: T[] | undefined,
  query: string,
  options: IFuseOptions<T>,
): T[] | undefined {
  const fuse = useMemo(
    () => (items ? new Fuse(items, options) : undefined),
    [items, options],
  );

  return useMemo(() => {
    if (!items) return undefined;

    const trimmedQuery = query.trim();
    if (!trimmedQuery) return items;

    return fuse?.search(trimmedQuery).map(({ item }) => item) ?? [];
  }, [fuse, items, query]);
}
