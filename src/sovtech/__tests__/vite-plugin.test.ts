import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { APP_NAME as RUNTIME_APP_NAME } from "@/lib/constants";
import {
  AUDITED_SENTINEL,
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
  auditSummary,
  isStrictBuild,
  parseShadowMap,
  rebrandIndexHtml,
  resolveShadow,
  rewriteSource,
  scopedPath,
  shadowKey,
  shadowTargets,
  sovtech,
  withAuditedMark,
  type BuildMode,
  type ResolveUpstream,
} from "@/sovtech/vite-plugin";

const root = process.cwd();
const EXAMPLE = "src/components/Example.tsx";
const SHADOW_MAP = "ci/sovtech/shadow-map.tsv";
const CSP_META =
  /<meta\b[^>]*?http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi;

/**
 * Upstream files that between them fire every global rule. None is shadowed:
 * a shadowed module never reaches the transform in a build.
 */
const GLOBAL_RULE_FILES = [
  "src/components/CreateRepoDialog.tsx",
  "src/components/EventCardActions.tsx",
  "src/components/IncompatibleProtocolError.tsx",
];

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

describe("rule tables", () => {
  it("makes every global rule global and every exact rule countable", () => {
    for (const rule of GLOBAL_RULES) expect(rule.pattern.flags).toContain("g");
    for (const rule of EXACT_RULES) {
      expect(rule.find.length).toBeGreaterThan(0);
      expect(rule.count).toBeGreaterThan(0);
    }
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

  it("fires the global rules from files the shadow map leaves alone", () => {
    const shadowed = parseShadowMap(read(SHADOW_MAP)).map(
      (row) => row.upstreamPath,
    );
    for (const file of GLOBAL_RULE_FILES) expect(shadowed).not.toContain(file);
  });

  it("finds every global rule somewhere in upstream source", () => {
    const seen = new Set<string>();
    for (const file of GLOBAL_RULE_FILES) {
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
    const rows = parseShadowMap(read(SHADOW_MAP));
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

describe("resolveShadow", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sovtech-shadow-")));
  const file = (rel: string) => join(base, rel);
  const header = "src/components/AppHeader.tsx";
  const overlay = "src/sovtech/overlays/AppHeader.tsx";
  for (const rel of [header, overlay, "src/pages/AppHeader.tsx"]) {
    mkdirSync(dirname(file(rel)), { recursive: true });
    writeFileSync(file(rel), "");
  }
  const row = { upstreamPath: header, overlayPath: overlay };
  const targets = shadowTargets([row], base);
  const importer = file("src/components/AppLayout.tsx");
  const fromOverlay = file("src/sovtech/overlays/Shell.tsx");

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  function run(source: string, from: string, upstream: ResolveUpstream) {
    return resolveShadow(targets, [base], source, from, upstream);
  }

  function resolvesTo(id: string): ResolveUpstream {
    return async () => ({ id, external: false });
  }

  it("swaps an import that resolves to the shadowed module", async () => {
    const upstream = resolvesTo(file(header));
    const found = await run("./AppHeader", importer, upstream);
    expect(found?.overlay).toBe(file(overlay));
    const aliased = await run("@/components/AppHeader", importer, upstream);
    expect(aliased?.key).toBe(shadowKey(row));
  });

  it("leaves a module with the same name elsewhere alone", async () => {
    const other = resolvesTo(file("src/pages/AppHeader.tsx"));
    expect(await run("./AppHeader", importer, other)).toBeNull();
  });

  it("ignores external and failed resolutions", async () => {
    const external = async () => ({ id: file(header), external: true });
    expect(await run("./AppHeader", importer, external)).toBeNull();
    expect(await run("./AppHeader", importer, async () => null)).toBeNull();
  });

  it("resolves only shadowed names, and never for an overlay", async () => {
    let calls = 0;
    const counted: ResolveUpstream = async () => {
      calls += 1;
      return { id: file(header) };
    };
    expect(await run("./AppFooter", importer, counted)).toBeNull();
    expect(await run("./AppHeader", fromOverlay, counted)).toBeNull();
    expect(calls).toBe(0);
    expect(await run("./AppHeader", importer, counted)).not.toBeNull();
    expect(calls).toBe(1);
  });

  it("refuses a row whose overlay file is missing", () => {
    const gone = [{ upstreamPath: header, overlayPath: "src/sovtech/X.tsx" }];
    expect(() => shadowTargets(gone, base)).toThrow(/missing/);
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

describe("isStrictBuild", () => {
  it("asserts the counts in a one-off vite build only", () => {
    const once: BuildMode = { command: "build", build: { watch: null } };
    const watching: BuildMode = { command: "build", build: { watch: {} } };
    expect(isStrictBuild(once)).toBe(true);
    expect(isStrictBuild({ command: "serve" })).toBe(false);
    expect(isStrictBuild(watching)).toBe(false);
  });
});

type Hook = (this: unknown, ...args: unknown[]) => unknown;

/** A hook's handler, whether the plugin defines it as a function or not. */
function hookOf(plugin: Plugin, name: keyof Plugin): Hook {
  const hook: unknown = plugin[name];
  if (typeof hook === "function") return hook as Hook;
  return (hook as { handler: Hook }).handler;
}

describe("the build audit", () => {
  const CHUNK = "render(app);\n";
  const rows = parseShadowMap(read(SHADOW_MAP));
  const context = {
    error(message: string): never {
      throw new Error(message);
    },
  };

  /** Upstream modules that between them fire every rule. */
  const modules = new Set([
    "src/main.tsx",
    ...GLOBAL_RULE_FILES,
    ...EXACT_RULES.map((rule) => rule.file),
  ]);

  /**
   * A plugin that has seen one build up to buildEnd: the modules above, an
   * import of every shadowed module and, when `html` is set, index.html.
   */
  async function build(command: BuildMode["command"], html: boolean) {
    const plugin = sovtech();
    const config = { root, command, build: { watch: null } };
    hookOf(plugin, "configResolved").call(undefined, config);
    hookOf(plugin, "buildStart").call(context, {});
    const transform = hookOf(plugin, "transform");
    for (const file of modules) {
      transform.call(context, read(file), resolve(root, file));
    }
    const resolveId = hookOf(plugin, "resolveId");
    const importer = resolve(root, "src/App.tsx");
    for (const row of rows) {
      const id = resolve(root, row.upstreamPath);
      const upstream = { resolve: async () => ({ id }) };
      const options = { attributes: {}, isEntry: false };
      const source = `./${basename(row.upstreamPath)}`;
      await resolveId.call(upstream, source, importer, options);
    }
    const indexHtml = hookOf(plugin, "transformIndexHtml");
    if (html) indexHtml.call(undefined, read("index.html"));
    return plugin;
  }

  /** Runs buildEnd and returns what it wrote to stdout. */
  function finish(plugin: Plugin): string[] {
    const write = vi.spyOn(process.stdout, "write");
    write.mockImplementation(() => true);
    try {
      hookOf(plugin, "buildEnd").call(context);
      return write.mock.calls.map((call) => String(call[0]));
    } finally {
      write.mockRestore();
    }
  }

  function render(plugin: Plugin, isEntry: boolean): unknown {
    return hookOf(plugin, "renderChunk").call(context, CHUNK, { isEntry });
  }

  it("prints one line and marks the entry chunk once it passes", async () => {
    const plugin = await build("build", true);
    expect(render(plugin, true)).toBeNull();
    expect(finish(plugin)).toEqual([`${auditSummary(rows)}\n`]);
    const marked = { code: withAuditedMark(CHUNK), map: null };
    expect(render(plugin, true)).toEqual(marked);
    expect(render(plugin, false)).toBeNull();
  });

  it("appends a statement that sets the audited sentinel", () => {
    const code = withAuditedMark(CHUNK);
    expect(code.startsWith(CHUNK)).toBe(true);
    expect(code).toContain(`Symbol.for("${AUDITED_SENTINEL}"), true);`);
    expect(auditSummary(rows)).toMatch(/^SovTech overlay: audit passed /);
  });

  it("fails a build whose audit fails, and never marks it", async () => {
    const plugin = await build("build", false);
    expect(() => finish(plugin)).toThrow(/index.html was never transformed/);
    expect(render(plugin, true)).toBeNull();
  });

  it("forgets a passed audit when the next build starts", async () => {
    const plugin = await build("build", true);
    finish(plugin);
    hookOf(plugin, "buildStart").call(context, {});
    expect(render(plugin, true)).toBeNull();
  });

  it("neither audits nor marks outside vite build", async () => {
    const plugin = await build("serve", false);
    expect(finish(plugin)).toEqual([]);
    expect(render(plugin, true)).toBeNull();
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
