import { Expressions } from "applesauce-core/helpers/regexp";
import { stripInvisibleChar } from "applesauce-core/helpers/string";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Match the normalization used for manually entered issue labels. */
export function normaliseHashtag(tag: string): string {
  return stripInvisibleChar(tag.toLocaleLowerCase());
}

/** Extract issue labels from Markdown prose, excluding code and other literals. */
export function extractIssueHashtags(content: string): string[] {
  const labels = new Set<string>();

  function visit(node: MarkdownNode): void {
    if (node.type === "text" && node.value) {
      for (const match of node.value.matchAll(Expressions.hashtag)) {
        labels.add(normaliseHashtag(match[1]));
      }
    }
    node.children?.forEach(visit);
  }

  visit(parser.parse(content));
  return [...labels];
}
