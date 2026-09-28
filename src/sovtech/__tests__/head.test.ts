import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { InferSeoMetaPlugin } from "@unhead/addons";
import { createHead } from "@unhead/react/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { rebrandTitle, sovtechTitlePlugin } from "@/sovtech/head";

const root = process.cwd();
const OVERLAY = join(root, "src", "sovtech");
const SOURCE = /\.tsx?$/;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
/** Stands in for each ${…} of a template literal. */
const HOLE = "${}";

/**
 * The app name as a title suffix or prefix, whatever the separator: wider
 * than the rewrite's own patterns, so a literal that changes its separator
 * is still found, and then fails the test because the rewrite missed it.
 */
const TITLE_SUFFIX = /\s[^\sA-Za-z0-9]\s?ngit$/i;
const TITLE_PREFIX = /^ngit\s[^\sA-Za-z0-9]\s/i;

interface TitleLiteral {
  file: string;
  text: string;
}

function isTitle(text: string): boolean {
  return TITLE_SUFFIX.test(text) || TITLE_PREFIX.test(text);
}

/** Upstream source files under `dir`, without the overlay or tests. */
function upstreamSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const skip = ["__tests__", "test"].includes(entry.name);
      if (!skip && path !== OVERLAY) files.push(...upstreamSources(path));
    } else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Every string and template literal in a source file, parsed by tsc. */
function literalsOf(file: string, source: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    kind,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      found.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text];
      for (const span of node.templateSpans) {
        parts.push(HOLE, span.literal.text);
      }
      found.push(parts.join(""));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** The title-style literals in upstream source, read raw from disk. */
function upstreamTitles(): TitleLiteral[] {
  const titles: TitleLiteral[] = [];
  for (const path of upstreamSources(join(root, "src"))) {
    const source = readFileSync(path, "utf8");
    if (!/ngit/i.test(source)) continue;
    const file = relative(root, path);
    for (const text of literalsOf(file, source).filter(isTitle)) {
      titles.push({ file, text });
    }
  }
  return titles;
}

interface Tag {
  tag: string;
  props: Record<string, string>;
  textContent?: string;
}

/** A head wired like src/App.tsx: InferSeoMetaPlugin, then the fork's. */
function makeHead() {
  return createHead({
    disableDefaults: true,
    plugins: [InferSeoMetaPlugin(), sovtechTitlePlugin()],
  });
}

function titleOf(tags: Tag[]): string | undefined {
  return tags.find((tag) => tag.tag === "title")?.textContent;
}

function metaOf(tags: Tag[], key: string): string | undefined {
  const meta = tags.find((tag) => {
    if (tag.tag !== "meta") return false;
    return tag.props.property === key || tag.props.name === key;
  });
  return meta?.props.content;
}

describe("rebrandTitle", () => {
  it("replaces the ngit suffix and keeps its separator", () => {
    const branches = rebrandTitle("Branches - demo - ngit");
    expect(branches).toBe("Branches - demo - SovTech Git");
    expect(rebrandTitle("About — ngit")).toBe("About — SovTech Git");
  });

  it("replaces the landing page's ngit prefix", () => {
    const landing = rebrandTitle("ngit — Decentralized Git over Nostr");
    expect(landing).toBe("SovTech Git — Decentralized Git over Nostr");
  });

  it("leaves other mentions of ngit alone", () => {
    expect(rebrandTitle("Install ngit")).toBe("Install ngit");
    expect(rebrandTitle("ngit - ngit")).toBe("ngit - SovTech Git");
    const subject = rebrandTitle("ngit — fix it - ngit");
    expect(subject).toBe("ngit — fix it - SovTech Git");
    expect(rebrandTitle("ngit-tools - about")).toBe("ngit-tools - about");
  });
});

describe("sovtechTitlePlugin", () => {
  it("rewrites the title and the inferred og:title", async () => {
    const head = makeHead();
    head.push({ title: "Issues - demo - ngit" });
    const tags = await head.resolveTags();
    expect(titleOf(tags)).toBe("Issues - demo - SovTech Git");
    expect(metaOf(tags, "og:title")).toBe("Issues - demo - SovTech Git");
  });

  it("rewrites the social title and image-alt copies", async () => {
    const head = makeHead();
    const landing = "ngit — Decentralized Git over Nostr";
    head.push({
      title: landing,
      meta: [
        { name: "twitter:title", content: "PRs - demo - ngit" },
        { property: "og:image:alt", content: landing },
        { name: "twitter:image:alt", content: landing },
        { name: "description", content: landing },
      ],
    });
    const tags = await head.resolveTags();
    const branded = "SovTech Git — Decentralized Git over Nostr";
    expect(titleOf(tags)).toBe(branded);
    expect(metaOf(tags, "og:title")).toBe(branded);
    expect(metaOf(tags, "twitter:title")).toBe("PRs - demo - SovTech Git");
    expect(metaOf(tags, "og:image:alt")).toBe(branded);
    expect(metaOf(tags, "twitter:image:alt")).toBe(branded);
    expect(metaOf(tags, "description")).toBe(landing);
  });

  it("leaves titles without the app name as they are", async () => {
    const head = makeHead();
    head.push({ title: "Install ngit" });
    const tags = await head.resolveTags();
    expect(titleOf(tags)).toBe("Install ngit");
    expect(metaOf(tags, "og:title")).toBe("Install ngit");
  });
});

// The dead-rule check for the title rewrite: every title upstream sets must
// still match it, so an upstream change of separator fails here.
describe("upstream page titles", () => {
  const titles = upstreamTitles();

  it("finds the titles upstream pages set", () => {
    expect(titles.length).toBeGreaterThanOrEqual(30);
  });

  it("rebrands every one of them", () => {
    const missed: string[] = [];
    for (const title of titles) {
      if (rebrandTitle(title.text) === title.text) {
        missed.push(`${title.file}: ${title.text}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("would find a title whose separator the rewrite misses", () => {
    const planted = [
      'const a = "About · ngit";',
      "const b = `Tags - ${repo.name} | ngit`;",
      "const c = `Tags - ${repo.name} - ngit`;",
      'const d = "Install ngit";',
    ].join("\n");
    const found = literalsOf("Planted.ts", planted).filter(isTitle);
    expect(found).toEqual([
      "About · ngit",
      "Tags - ${} | ngit",
      "Tags - ${} - ngit",
    ]);
    const missed = found.filter((text) => rebrandTitle(text) === text);
    expect(missed).toEqual(["About · ngit", "Tags - ${} | ngit"]);
  });
});
