/**
 * Re-brands the "ngit" in upstream page titles at runtime. Upstream pages set
 * titles such as "Branches - <repo> - ngit" and "ngit — Decentralized Git
 * over Nostr" in files the fork must not edit, so this unhead plugin rewrites
 * the resolved title and its social copies instead. It runs in tags:resolve,
 * after InferSeoMetaPlugin has copied the title into og:title.
 */
import { defineHeadPlugin } from "@unhead/react/plugins";

Reflect.set(globalThis, Symbol.for("sovtech-overlay:head"), true);

const APP_NAME = "SovTech Git";

/** " - ngit" or " — ngit" at the end, keeping the separator. */
const SUFFIX = / ([-—]) ngit$/;
/** "ngit — " at the start (the landing page). */
const PREFIX = /^ngit — /;

/** Meta tags that carry a copy of the title. */
const TITLE_META = new Set([
  "og:title",
  "twitter:title",
  "og:image:alt",
  "twitter:image:alt",
]);

/**
 * The fork's title for an upstream one. Only the app-name suffix is replaced
 * when there is one, so a page title that itself starts with "ngit — " (an
 * issue subject, say) keeps its own text.
 */
export function rebrandTitle(title: string): string {
  if (SUFFIX.test(title)) return title.replace(SUFFIX, ` $1 ${APP_NAME}`);
  return title.replace(PREFIX, `${APP_NAME} — `);
}

/** The parts of a resolved unhead tag this plugin reads and writes. */
interface ResolvedTag {
  tag: string;
  props: Record<string, string>;
  textContent?: string;
}

function isTitleMeta(tag: ResolvedTag): boolean {
  if (tag.tag !== "meta" || typeof tag.props.content !== "string") {
    return false;
  }
  return TITLE_META.has(tag.props.property || tag.props.name || "");
}

export function sovtechTitlePlugin() {
  return defineHeadPlugin({
    key: "sovtech-title",
    hooks: {
      "tags:resolve": (ctx: { tags: ResolvedTag[] }) => {
        for (const tag of ctx.tags) {
          if (tag.tag === "title" && typeof tag.textContent === "string") {
            tag.textContent = rebrandTitle(tag.textContent);
          } else if (isTitleMeta(tag)) {
            tag.props.content = rebrandTitle(tag.props.content);
          }
        }
      },
    },
  });
}
