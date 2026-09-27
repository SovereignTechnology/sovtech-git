import { InferSeoMetaPlugin } from "@unhead/addons";
import { createHead } from "@unhead/react/server";
import { describe, expect, it } from "vitest";
import { rebrandTitle, sovtechTitlePlugin } from "@/sovtech/head";

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
