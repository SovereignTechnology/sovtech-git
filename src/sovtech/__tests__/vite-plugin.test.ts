import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME as RUNTIME_APP_NAME } from "@/lib/constants";
import {
  ENGINE_RULE,
  ENGINE_SENTINEL,
  EXACT_RULES,
  FUNCTIONAL_FILES,
  GLOBAL_RULES,
  INDEX_HTML_KEY,
  MANIFEST_JSON,
  SHADOW_HEADER,
  SOVTECH_MANIFEST,
  auditCounts,
  parseShadowMap,
  rebrandIndexHtml,
  rewriteSource,
  scopedPath,
  shadowKey,
} from "@/sovtech/vite-plugin";

const root = process.cwd();
const EXAMPLE = "src/components/Example.tsx";
const CSP_META =
  /<meta\b[^>]*?http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi;

function read(file: string): string {
  return readFileSync(resolve(root, file), "utf8");
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function metaContent(doc: Document, selector: string): string | null {
  const element = doc.querySelector(`meta[${selector}]`);
  return element?.getAttribute("content") ?? null;
}

describe("app name define", () => {
  it("resolves the __APP_NAME__ define from vite.config.ts", () => {
    expect(__APP_NAME__).toBe("SovTech Git");
    expect(RUNTIME_APP_NAME).toBe("SovTech Git");
  });
});

describe("rewriteSource", () => {
  it("rewrites the upstream name, links and copy-link labels", () => {
    const code = [
      '<img src="/icons/icon.svg" alt="GitWorkshop" />',
      "const link = `https://gitworkshop.dev/${nip19Id}`;",
      '<a href="https://www.gitworkshop.dev">Learn more</a>',
      '<CopyRow label="gitworkshop.dev" value={link} />',
      "const brand = 'GitWorkshop.dev';",
    ].join("\n");
    const result = rewriteSource(code, EXAMPLE);
    expect(result.code).toContain('alt="SovTech Git"');
    expect(result.code).toContain("`https://git.sovtech.pro/${nip19Id}`");
    expect(result.code).toContain('href="https://git.sovtech.pro"');
    expect(result.code).toContain('label="git.sovtech.pro"');
    expect(result.code).toContain("const brand = 'SovTech Git';");
    expect(result.code).not.toMatch(/gitworkshop/i);
    expect(result.hits.get("url")).toBe(2);
    expect(result.hits.get("copy-label")).toBe(1);
    expect(result.hits.get("name")).toBe(2);
  });

  it("turns a capitalised upstream URL into a URL, not the name", () => {
    const result = rewriteSource('href="https://GitWorkshop.dev/x"', EXAMPLE);
    expect(result.code).toBe('href="https://git.sovtech.pro/x"');
  });

  it("never touches functional identifiers or the bare host", () => {
    const code = [
      'const HOSTS = new Set(["gitworkshop.dev", "www.gitworkshop.dev"]);',
      'const DB_NAME = "gitworkshop";',
      'const OUTBOX = "gitworkshop-outbox";',
      "const key = `gitworkshop:draft:v1:${pubkey}`;",
      'const D_TAG = "gitworkshop-repo-selections-v1";',
      'const RELOAD = "gitworkshop-reload";',
      'rpc.call("server.version", ["gitworkshop/namecoin-nip05", "1.4"]);',
      "export function getGitWorkshopPath(url: string) {}",
      "const next = 'https://gitworkshop.devs/';",
    ].join("\n");
    const result = rewriteSource(code, EXAMPLE);
    expect(result.code).toBe(code);
    expect(result.hits.size).toBe(0);
  });

  it("skips the host-set files, which keep upstream's literals", () => {
    for (const file of FUNCTIONAL_FILES) {
      expect(scopedPath(resolve(root, file), [root])).toBeNull();
      expect(read(file)).toMatch(/"gitworkshop\.dev"/);
    }
    const hosts = rewriteSource(read(FUNCTIONAL_FILES[0]), EXAMPLE);
    expect(hosts.code).toContain('"gitworkshop.dev", "www.gitworkshop.dev"');
  });

  it("matches each exact rule in its upstream file exactly", () => {
    for (const rule of EXACT_RULES) {
      const result = rewriteSource(read(rule.file), rule.file);
      expect(result.hits.get(rule.id)).toBe(rule.count);
      expect(result.code).toContain(rule.replacement);
      expect(result.code).not.toContain(rule.find);
    }
  });

  it("leaves the exact rules' strings alone in other files", () => {
    const code = EXACT_RULES.map((rule) => rule.find).join("\n");
    expect(rewriteSource(code, EXAMPLE).code).toBe(code);
  });

  it("adds the engine sentinel to the app entry only", () => {
    const entry = rewriteSource(read("src/main.tsx"), "src/main.tsx");
    expect(entry.code).toContain(`Symbol.for("${ENGINE_SENTINEL}")`);
    expect(entry.hits.get(ENGINE_RULE)).toBe(1);
    expect(rewriteSource("", EXAMPLE).code).toBe("");
  });

  it("finds every global rule somewhere in upstream source", () => {
    const files = [
      "src/components/AppHeader.tsx",
      "src/components/EventCardActions.tsx",
      "src/components/IncompatibleProtocolError.tsx",
    ];
    const seen = new Set<string>();
    for (const file of files) {
      for (const key of rewriteSource(read(file), file).hits.keys()) {
        seen.add(key);
      }
    }
    for (const rule of GLOBAL_RULES) expect([...seen]).toContain(rule.id);
  });
});

describe("scopedPath", () => {
  const at = (file: string) => scopedPath(resolve(root, file), [root]);

  it("limits the rules to upstream source under src/", () => {
    const header = "src/components/AppHeader.tsx";
    expect(at(header)).toBe(header);
    expect(at("src/main.tsx")).toBe("src/main.tsx");
    expect(at("src/sovtech/head.ts")).toBeNull();
    expect(at("src/sovtech/__tests__/head.test.ts")).toBeNull();
    expect(at("src/lib/__tests__/routeUtils.test.ts")).toBeNull();
    expect(at("src/test/setup.ts")).toBeNull();
    expect(at("src/index.css")).toBeNull();
    expect(at("index.html")).toBeNull();
    expect(at("vite.config.ts")).toBeNull();
  });

  it("skips virtual ids and query ids such as ?raw", () => {
    const app = resolve(root, "src/App.tsx");
    expect(scopedPath(`${app}?raw`, [root])).toBeNull();
    expect(scopedPath(`\0${app}`, [root])).toBeNull();
    expect(scopedPath("/elsewhere/src/App.tsx", [root])).toBeNull();
  });
});

describe("shadow map", () => {
  const header = SHADOW_HEADER.join("\t");
  const row = [
    "src/components/AppHeader.tsx",
    "src/sovtech/overlays/AppHeader.tsx",
    "0".repeat(40),
    "sovtech-overlay:header",
    "upstream-header-marker",
  ].join("\t");

  it("parses the committed map, whose files all exist", () => {
    const rows = parseShadowMap(read("ci/sovtech/shadow-map.tsv"));
    for (const entry of rows) {
      expect(existsSync(resolve(root, entry.upstreamPath))).toBe(true);
      expect(existsSync(resolve(root, entry.overlayPath))).toBe(true);
    }
  });

  it("reads rows after the header and skips comments", () => {
    const rows = parseShadowMap(`# note\n${header}\n${row}\n`);
    expect(rows).toEqual([
      {
        upstreamPath: "src/components/AppHeader.tsx",
        overlayPath: "src/sovtech/overlays/AppHeader.tsx",
      },
    ]);
    expect(parseShadowMap(`${header}\n`)).toEqual([]);
  });

  it("refuses malformed maps", () => {
    const bad = [
      "",
      `${header}\r\n`,
      `${header}\n${row}\textra\n`,
      `${header}\n${row}\n${row}\n`,
      `${header}\n${row.replace("src/sovtech/overlays", "src/other")}\n`,
      `${header}\n${row.replace("src/components", "src/../../etc")}\n`,
    ];
    for (const text of bad) expect(() => parseShadowMap(text)).toThrow();
  });
});

describe("auditCounts", () => {
  const rows = [
    {
      upstreamPath: "src/components/AppHeader.tsx",
      overlayPath: "src/sovtech/overlays/AppHeader.tsx",
    },
  ];

  function cleanCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const rule of GLOBAL_RULES) counts.set(rule.id, 3);
    for (const rule of EXACT_RULES) counts.set(rule.id, rule.count);
    counts.set(ENGINE_RULE, 1);
    counts.set(INDEX_HTML_KEY, 1);
    counts.set(shadowKey(rows[0]), 2);
    return counts;
  }

  it("passes a build where every rule and row fired", () => {
    expect(auditCounts(cleanCounts(), rows)).toEqual([]);
  });

  it("reports every rule, row and page that did not", () => {
    const problems = auditCounts(new Map(), rows);
    const expected = GLOBAL_RULES.length + EXACT_RULES.length + 3;
    expect(problems).toHaveLength(expected);
  });

  it("reports an exact rule whose count moved", () => {
    const counts = cleanCounts();
    counts.set(EXACT_RULES[0].id, EXACT_RULES[0].count + 1);
    expect(auditCounts(counts, rows)).toHaveLength(1);
  });
});

describe("rebrandIndexHtml", () => {
  const upstream = read("index.html");
  const html = rebrandIndexHtml(upstream);
  const doc = parseHtml(html);

  it("points og:url and the images at git.sovtech.pro", () => {
    const image = "https://git.sovtech.pro/og-image.png";
    const url = metaContent(doc, 'property="og:url"');
    expect(url).toBe("https://git.sovtech.pro/");
    expect(metaContent(doc, 'property="og:image"')).toBe(image);
    expect(metaContent(doc, 'property="og:image:secure_url"')).toBe(image);
    expect(metaContent(doc, 'name="twitter:image"')).toBe(image);
  });

  it("replaces all four %APP_NAME% tokens and the titles", () => {
    const title = "SovTech Git — Decentralized Git over Nostr";
    expect(upstream.split("%APP_NAME%")).toHaveLength(5);
    expect(html).not.toContain("%APP_NAME%");
    expect(doc.title).toBe(title);
    expect(metaContent(doc, 'property="og:title"')).toBe(title);
    expect(metaContent(doc, 'property="og:image:alt"')).toBe(title);
    expect(metaContent(doc, 'name="twitter:image:alt"')).toBe(title);
  });

  it("describes SovTech Git in the description metas", () => {
    const description = metaContent(doc, 'name="description"');
    expect(description).toMatch(/^SovTech Git is Sovereign Technology's/);
    expect(metaContent(doc, 'property="og:description"')).toBe(description);
  });

  it("brands the splash in SovTech colours", () => {
    const name = doc.querySelector(".splash-name")?.textContent;
    expect(name).toBe("SovTech Git");
    expect(html).toContain("background: #0A0A0A;");
    expect(html).toContain("border-top-color: #F7931A;");
    expect(html).not.toMatch(/#16171e|#ff79c6/i);
  });

  it("leaves no upstream branding", () => {
    expect(html).not.toMatch(/gitworkshop\.dev|\bGitWorkshop\b/i);
  });

  it("keeps the CSP meta byte-identical", () => {
    const before = upstream.match(CSP_META);
    expect(before).toHaveLength(1);
    expect(html.match(CSP_META)).toEqual(before);
  });

  it("fails when an anchor it rewrites moves", () => {
    const moved = upstream.replace('property="og:url"', 'property="og:link"');
    expect(() => rebrandIndexHtml(moved)).toThrow(/og:url/);
    const extra = upstream.replace("%APP_NAME%", "%APP_NAME% %APP_NAME%");
    expect(() => rebrandIndexHtml(extra)).toThrow(/APP_NAME/);
    const noSplash = upstream.replace('class="splash-name"', 'class="x"');
    expect(() => rebrandIndexHtml(noSplash)).toThrow(/splash name/);
  });
});

describe("manifest", () => {
  it("swaps public/manifest.webmanifest to what the build emits", () => {
    const swapped = JSON.parse(read("public/manifest.webmanifest"));
    expect(swapped).toEqual(SOVTECH_MANIFEST);
    expect(JSON.parse(MANIFEST_JSON)).toEqual(SOVTECH_MANIFEST);
  });

  it("names SovTech Git and keeps upstream's icon files", () => {
    expect(SOVTECH_MANIFEST.name).toBe("SovTech Git");
    expect(SOVTECH_MANIFEST.short_name).toBe("SovTech Git");
    expect(SOVTECH_MANIFEST.theme_color).toBe("#0A0A0A");
    expect(SOVTECH_MANIFEST.background_color).toBe("#0A0A0A");
    expect(SOVTECH_MANIFEST.icons).toHaveLength(4);
    for (const icon of SOVTECH_MANIFEST.icons) {
      expect(existsSync(resolve(root, `public${icon.src}`))).toBe(true);
    }
    expect(MANIFEST_JSON).not.toMatch(/gitworkshop/i);
  });
});
