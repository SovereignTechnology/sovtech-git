import { hasNameValueTag } from "applesauce-core/helpers";
import { nip19, type NostrEvent } from "nostr-tools";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { ISSUE_KIND, PATCH_KIND, PR_KIND } from "@/lib/nip34";

export const ITEM_REFERENCE_KINDS = [ISSUE_KIND, PATCH_KIND, PR_KIND];
const parser = unified().use(remarkParse).use(remarkGfm);

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/** Autocomplete belongs in prose, including a lone # before it becomes a heading. */
export function isHashtagProse(content: string, position: number): boolean {
  const probe =
    content.slice(0, position + 1) + "hashtag" + content.slice(position + 1);
  function containsText(node: MarkdownNode): boolean {
    if (node.type === "link" || node.type === "linkReference") return false;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      return (
        start !== undefined &&
        end !== undefined &&
        start <= position &&
        position < end
      );
    }
    return node.children?.some(containsText) ?? false;
  }
  return containsText(parser.parse(probe));
}

/** Resolve only unambiguous issue/PR prefixes in prose, preserving Markdown. */
export function resolveShortItemReferences(
  content: string,
  events: readonly NostrEvent[],
) {
  const items = events.filter(
    (event) =>
      event.kind === ISSUE_KIND ||
      event.kind === PR_KIND ||
      (event.kind === PATCH_KIND &&
        hasNameValueTag(event, "t", "root") &&
        !hasNameValueTag(event, "t", "root-revision") &&
        !hasNameValueTag(event, "t", "revision-root")),
  );
  const replacements: { start: number; end: number; text: string }[] = [];

  function visit(node: MarkdownNode): void {
    if (node.type === "link" || node.type === "linkReference") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) {
      const source = content.slice(start, end);
      for (const match of source.matchAll(
        /(?<![\p{L}\p{N}\p{M}_/#\\])#([a-f0-9]{8,64})(?![\p{L}\p{N}\p{M}_])/giu,
      )) {
        const prefix = match[1].toLowerCase();
        const matches = items.filter((event) => event.id.startsWith(prefix));
        if (matches.length !== 1) continue;
        const event = matches[0];
        replacements.push({
          start: start + match.index!,
          end: start + match.index! + match[0].length,
          text: `nostr:${nip19.neventEncode({
            id: event.id,
            author: event.pubkey,
            kind: event.kind,
          })}`,
        });
      }
    }
    node.children?.forEach(visit);
  }

  visit(parser.parse(content));
  let value = content;
  for (const replacement of [...replacements].reverse()) {
    value =
      value.slice(0, replacement.start) +
      replacement.text +
      value.slice(replacement.end);
  }
  return {
    value,
    mapCursor(position: number): number {
      let shift = 0;
      for (const replacement of replacements) {
        if (position <= replacement.start) break;
        if (position < replacement.end)
          return replacement.start + shift + replacement.text.length;
        shift +=
          replacement.text.length - (replacement.end - replacement.start);
      }
      return position + shift;
    },
  };
}
