/**
 * The SovTech Git overlay engine: one Vite plugin that re-brands upstream at
 * build time, so upstream files stay untouched outside the listed seams.
 *
 * - config: the app name define and hidden source maps.
 * - resolveId: swaps each upstream module listed in ci/sovtech/shadow-map.tsv
 *   for its overlay under src/sovtech/, whatever path imports it.
 * - transform: rewrites upstream brand copy in raw source under src/.
 * - transformIndexHtml: re-brands index.html; the CSP meta is never touched.
 * - configureServer and generateBundle: serve and emit the SovTech manifest.
 * - renderChunk: marks the entry chunk of a build whose audit passed.
 *
 * `vite build` fails when a rule stops matching (buildEnd), so upstream copy
 * that moves breaks the build instead of shipping upstream branding. A build
 * whose audit passed prints one line, even under `-l error`, and carries the
 * AUDITED_SENTINEL mark in its entry chunk, so a build that skipped the audit
 * shows in dist. The dev server and vitest share this plugin but never run
 * those assertions.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

export const APP_NAME = "SovTech Git";
export const SITE_URL = "https://git.sovtech.pro";

/** The engine's own sentinel, appended to the app entry. */
export const ENGINE_SENTINEL = "sovtech-overlay:engine";
export const ENGINE_RULE = "engine-sentinel";
const ENGINE_ENTRY = "src/main.tsx";

/** Set by the entry chunk of a `vite build` whose audit passed. */
export const AUDITED_SENTINEL = "sovtech-overlay:audited";

export const INDEX_HTML_KEY = "index-html";
const MANIFEST_FILE = "manifest.webmanifest";
const OVERLAY_DIR = "src/sovtech/";
const SHADOW_MAP = "ci/sovtech/shadow-map.tsv";
export const SHADOW_HEADER = [
  "upstream_path",
  "overlay_path",
  "acked_blob",
  "sentinel",
  "upstream_marker",
];

/**
 * Never rewritten: the host sets that recognise upstream links pasted as
 * input. They stay upstream's (brand-allowlist.json "functional").
 */
export const FUNCTIONAL_FILES = [
  "src/lib/gitworkshopUrl.ts",
  "src/lib/repoUpstreamInput.ts",
];

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|test)\/|\.(?:test|spec)\.[^/]+$/;

export interface GlobalRule {
  id: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Rules over every upstream source file; each must match at least once in a
 * build. The URL rule runs first so a capitalised host inside a URL becomes
 * a URL, not the name.
 *
 * The bare lowercase host is left alone on purpose. The copy that still names
 * it describes upstream (About, the landing page), the footer that the shell
 * overlay replaces, or input the upstream host sets still accept
 * (SubordinateForkField); the storage names and d-tags are functional.
 */
export const GLOBAL_RULES: GlobalRule[] = [
  {
    id: "url",
    pattern: /https?:\/\/(?:www\.)?gitworkshop\.dev(?=[/"'`])/gi,
    replacement: SITE_URL,
  },
  {
    id: "copy-label",
    pattern: /label="gitworkshop\.dev"/g,
    replacement: 'label="git.sovtech.pro"',
  },
  {
    id: "name",
    pattern: /\bGitWorkshop(?:\.dev)?\b/g,
    replacement: APP_NAME,
  },
];

export interface ExactRule {
  id: string;
  file: string;
  find: string;
  replacement: string;
  count: number;
}

/** Stable lowercase copy, each asserted to match exactly `count` times. */
export const EXACT_RULES: ExactRule[] = [
  {
    id: "merge-panel-servers",
    file: "src/components/MergePanel.tsx",
    find: "so gitworkshop can't safely update",
    replacement: "so SovTech Git can't safely update",
    count: 1,
  },
  {
    id: "merge-panel-direct",
    file: "src/components/MergePanel.tsx",
    find: "merging directly from gitworkshop isn't supported",
    replacement: "merging directly from SovTech Git isn't supported",
    count: 1,
  },
  {
    id: "nwc-app-name",
    file: "src/components/zap/NwcQrConnect.tsx",
    find: 'appName = "gitworkshop",',
    replacement: 'appName = "SovTech Git",',
    count: 1,
  },
  {
    id: "zap-app-name",
    file: "src/components/zap/ZapModal.tsx",
    find: 'appName="gitworkshop zap"',
    replacement: 'appName="SovTech Git zap"',
    count: 1,
  },
];

export interface Rewrite {
  code: string;
  hits: Map<string, number>;
}

/** Applies the rules to one module; `file` is its project-relative path. */
export function rewriteSource(code: string, file: string): Rewrite {
  const hits = new Map<string, number>();
  let out = code;
  for (const rule of GLOBAL_RULES) {
    let n = 0;
    out = out.replace(rule.pattern, () => {
      n += 1;
      return rule.replacement;
    });
    if (n > 0) hits.set(rule.id, n);
  }
  for (const rule of EXACT_RULES) {
    if (rule.file !== file) continue;
    const parts = out.split(rule.find);
    hits.set(rule.id, parts.length - 1);
    out = parts.join(rule.replacement);
  }
  if (file === ENGINE_ENTRY) {
    const key = JSON.stringify(ENGINE_SENTINEL);
    out += `\nReflect.set(globalThis, Symbol.for(${key}), true);\n`;
    hits.set(ENGINE_RULE, 1);
  }
  return { code: out, hits };
}

function inRewriteScope(file: string): boolean {
  if (!file.startsWith("src/") || file.startsWith(OVERLAY_DIR)) return false;
  if (!SOURCE_FILE.test(file) || TEST_FILE.test(file)) return false;
  return !FUNCTIONAL_FILES.includes(file);
}

/**
 * The project-relative path of a module the rules apply to, else null:
 * virtual and query ids (?raw and the like), files outside src/, the
 * overlay itself, tests and the functional host-set files are skipped.
 */
export function scopedPath(id: string, roots: string[]): string | null {
  if (id.startsWith("\0") || id.includes("?")) return null;
  const file = projectPath(id, roots);
  return file !== null && inRewriteScope(file) ? file : null;
}

/** An id's path relative to the first root that contains it, else null. */
function projectPath(id: string, roots: string[]): string | null {
  for (const root of roots) {
    const file = relative(root, id).split(sep).join("/");
    if (file === ".." || file.startsWith("../") || isAbsolute(file)) continue;
    return file;
  }
  return null;
}

export interface ShadowRow {
  upstreamPath: string;
  overlayPath: string;
}

function checkRowPath(path: string, prefix: string): void {
  const parts = path.split("/");
  const unsafe = parts.some((part) => ["", ".", ".."].includes(part));
  if (unsafe || !path.startsWith(prefix)) {
    throw new Error(`${SHADOW_MAP}: invalid path ${JSON.stringify(path)}`);
  }
}

/** Rows of ci/sovtech/shadow-map.tsv; fails closed on any irregularity. */
export function parseShadowMap(text: string): ShadowRow[] {
  if (text.includes("\r")) {
    throw new Error(`${SHADOW_MAP}: CRLF line endings are not allowed`);
  }
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    lines.push(line);
  }
  if (lines[0] !== SHADOW_HEADER.join("\t")) {
    throw new Error(`${SHADOW_MAP}: the header row is missing or changed`);
  }
  const rows: ShadowRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    const bad = fields.some((field) => field === "" || field !== field.trim());
    if (fields.length !== SHADOW_HEADER.length || bad) {
      throw new Error(`${SHADOW_MAP}: malformed row ${JSON.stringify(line)}`);
    }
    const [upstreamPath, overlayPath] = fields;
    checkRowPath(upstreamPath, "src/");
    checkRowPath(overlayPath, OVERLAY_DIR);
    if (upstreamPath.startsWith(OVERLAY_DIR)) {
      throw new Error(`${SHADOW_MAP}: an overlay cannot be shadowed`);
    }
    if (rows.some((row) => row.upstreamPath === upstreamPath)) {
      throw new Error(`${SHADOW_MAP}: duplicate row for ${upstreamPath}`);
    }
    rows.push({ upstreamPath, overlayPath });
  }
  return rows;
}

export function shadowKey(row: ShadowRow): string {
  return `shadow:${row.upstreamPath}`;
}

/** An import specifier's file name without a script extension. */
function moduleName(specifier: string): string {
  const bare = specifier.split("?")[0];
  const base = bare.slice(bare.lastIndexOf("/") + 1);
  return base.replace(SOURCE_FILE, "");
}

export interface ShadowTarget {
  key: string;
  name: string;
  upstream: string;
  overlay: string;
  upstreamIds: Set<string>;
}

export function shadowTargets(rows: ShadowRow[], root: string): ShadowTarget[] {
  return rows.map((row) => {
    const upstream = resolve(root, row.upstreamPath);
    const overlay = resolve(root, row.overlayPath);
    for (const file of [upstream, overlay]) {
      if (!existsSync(file)) {
        throw new Error(`${SHADOW_MAP} names a missing file: ${file}`);
      }
    }
    return {
      key: shadowKey(row),
      name: moduleName(row.upstreamPath),
      upstream,
      overlay: realpathSync(overlay),
      upstreamIds: new Set([upstream, realpathSync(upstream)]),
    };
  });
}

/** What resolving an import found, as far as shadowing needs to know. */
export interface UpstreamResolution {
  id: string;
  external?: unknown;
}

/** Resolves an import without this plugin (this.resolve with skipSelf). */
export type ResolveUpstream = () => Promise<UpstreamResolution | null>;

/**
 * The shadow target an import resolves to, else null. The resolver runs only
 * when the specifier names a shadowed module, and the swap happens only when
 * it resolves to that exact upstream file. Importers under src/sovtech/ keep
 * the upstream module, so an overlay can wrap its original; an overlay that
 * needs another overlay imports it by its own path.
 */
export async function resolveShadow(
  targets: ShadowTarget[],
  roots: string[],
  source: string,
  importer: string | undefined,
  resolveUpstream: ResolveUpstream,
): Promise<ShadowTarget | null> {
  if (!importer || targets.length === 0) return null;
  const name = moduleName(source);
  const matches = targets.filter((target) => target.name === name);
  if (matches.length === 0 || isOverlayImporter(importer, roots)) return null;
  const resolved = await resolveUpstream();
  if (!resolved || resolved.external) return null;
  const id = resolved.id;
  return matches.find((item) => item.upstreamIds.has(id)) ?? null;
}

/**
 * Everything a build must have seen: every global rule at least once, every
 * exact rule exactly its count, the engine sentinel, index.html and every
 * shadow row. Returns the problems found (empty when the build is clean).
 */
export function auditCounts(
  counts: Map<string, number>,
  rows: ShadowRow[],
): string[] {
  const problems: string[] = [];
  const seen = (key: string) => counts.get(key) ?? 0;
  for (const rule of GLOBAL_RULES) {
    if (seen(rule.id) === 0) problems.push(`rule ${rule.id} never matched`);
  }
  for (const rule of EXACT_RULES) {
    const n = seen(rule.id);
    if (n !== rule.count) {
      const where = `${rule.file}: ${n}, expected ${rule.count}`;
      problems.push(`rule ${rule.id} matched ${where}`);
    }
  }
  if (seen(ENGINE_RULE) !== 1) {
    problems.push(`the engine sentinel was not added to ${ENGINE_ENTRY}`);
  }
  if (seen(INDEX_HTML_KEY) === 0) {
    problems.push("index.html was never transformed");
  }
  for (const row of rows) {
    if (seen(shadowKey(row)) === 0) {
      problems.push(`shadow row ${row.upstreamPath} was never imported`);
    }
  }
  return problems;
}

/** The line a build prints once its audit has passed. */
export function auditSummary(rows: ShadowRow[]): string {
  const parts = [
    `${GLOBAL_RULES.length} global rules`,
    `${EXACT_RULES.length} exact rules`,
    `${rows.length} shadow rows`,
  ];
  return `SovTech overlay: audit passed (${parts.join(", ")})`;
}

/**
 * An entry chunk with the audited mark appended. renderChunk runs this after
 * minification, so the statement reaches dist as written; the leading newline
 * keeps it out of any trailing line comment.
 */
export function withAuditedMark(code: string): string {
  const key = JSON.stringify(AUDITED_SENTINEL);
  return `${code}\n;Reflect.set(globalThis, Symbol.for(${key}), true);\n`;
}

// ------------------------------------------------------------ index.html ---

const INDEX_TITLE = "SovTech Git — Decentralized Git over Nostr";
const INDEX_DESCRIPTION = [
  "SovTech Git is Sovereign Technology's decentralized Git client over Nostr:",
  "browse repositories, manage issues and collaborate on pull requests.",
].join(" ");
const OG_IMAGE = `${SITE_URL}/og-image.png`;
const SPLASH_TAGLINE = "Decentralized Git over Nostr";

/** [attribute, key, content] for each meta the fork sets, each once. */
const INDEX_META: [string, string, string][] = [
  ["name", "description", INDEX_DESCRIPTION],
  ["property", "og:url", `${SITE_URL}/`],
  ["property", "og:title", INDEX_TITLE],
  ["property", "og:description", INDEX_DESCRIPTION],
  ["property", "og:image", OG_IMAGE],
  ["property", "og:image:secure_url", OG_IMAGE],
  ["property", "og:image:alt", INDEX_TITLE],
  ["name", "twitter:image", OG_IMAGE],
  ["name", "twitter:image:alt", INDEX_TITLE],
];

const CSP_META =
  /<meta\b[^>]*?http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi;
const CONTENT_ATTR = /\scontent="[^"]*"/g;
const BRAND_RESIDUE = /gitworkshop\.dev|\bGitWorkshop\b|%APP_NAME%/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every match of a global pattern and asserts how many there were:
 * exactly `expected`, or at least one when `expected` is "some".
 */
function replaceCounted(
  html: string,
  pattern: RegExp,
  replacer: (match: string) => string,
  expected: number | "some",
  what: string,
): string {
  let n = 0;
  const out = html.replace(pattern, (match) => {
    n += 1;
    return replacer(match);
  });
  const ok = expected === "some" ? n > 0 : n === expected;
  if (!ok) {
    const want = expected === "some" ? "at least 1" : String(expected);
    throw new Error(`index.html: ${what} matched ${n}, expected ${want}`);
  }
  return out;
}

function setMetaContent(html: string, meta: [string, string, string]): string {
  const [attr, key, content] = meta;
  const pattern = new RegExp(
    `<meta\\b[^>]*\\s${attr}="${escapeRegExp(key)}"[^>]*>`,
    "g",
  );
  return replaceCounted(
    html,
    pattern,
    (tag) => {
      const value = ` content="${escapeHtml(content)}"`;
      return replaceCounted(tag, CONTENT_ATTR, () => value, 1, key);
    },
    1,
    `meta ${key}`,
  );
}

function wrapText(open: string, text: string, close: string): string {
  return `${open}${escapeHtml(text)}${close}`;
}

/**
 * Re-brands upstream's index.html. Runs before upstream's html-app-name
 * plugin, so it replaces %APP_NAME% itself. Every replacement asserts its
 * count, and the CSP meta must come out byte-identical.
 */
export function rebrandIndexHtml(html: string): string {
  const csp = html.match(CSP_META) ?? [];
  if (csp.length !== 1) {
    throw new Error(`index.html: ${csp.length} CSP metas, expected 1`);
  }
  let out = replaceCounted(html, /%APP_NAME%/g, () => APP_NAME, 4, "APP_NAME");
  out = replaceCounted(
    out,
    /https:\/\/gitworkshop\.dev\//g,
    () => `${SITE_URL}/`,
    "some",
    "the upstream URL",
  );
  out = replaceCounted(
    out,
    /<title>[^<]*<\/title>/g,
    () => wrapText("<title>", INDEX_TITLE, "</title>"),
    1,
    "<title>",
  );
  for (const meta of INDEX_META) out = setMetaContent(out, meta);
  out = replaceCounted(
    out,
    /<p class="splash-name">[^<]*<\/p>/g,
    () => wrapText('<p class="splash-name">', APP_NAME, "</p>"),
    1,
    "the splash name",
  );
  out = replaceCounted(
    out,
    /<p class="splash-tagline">[^<]*<\/p>/g,
    () => wrapText('<p class="splash-tagline">', SPLASH_TAGLINE, "</p>"),
    1,
    "the splash tagline",
  );
  out = replaceCounted(out, /#16171e/gi, () => "#0A0A0A", 2, "background");
  out = replaceCounted(out, /#ff79c6/gi, () => "#F7931A", 2, "accent");
  const after = out.match(CSP_META) ?? [];
  if (after.length !== 1 || after[0] !== csp[0]) {
    throw new Error("index.html: the CSP meta changed");
  }
  if (BRAND_RESIDUE.test(out)) {
    throw new Error("index.html: upstream branding survived the rewrite");
  }
  return out;
}

// -------------------------------------------------------------- manifest ---

export const SOVTECH_MANIFEST = {
  name: APP_NAME,
  short_name: APP_NAME,
  description: "Decentralized Git over Nostr, from Sovereign Technology",
  start_url: "/",
  display: "standalone",
  background_color: "#0A0A0A",
  theme_color: "#0A0A0A",
  categories: ["development", "productivity", "utilities"],
  icons: [
    {
      src: "/icons/icon-192x192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/pwa-maskable-192x192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "/icons/pwa-maskable-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

export const MANIFEST_JSON = JSON.stringify(SOVTECH_MANIFEST, null, 2);

// ---------------------------------------------------------------- plugin ---

function rootsOf(root: string): string[] {
  const real = realpathSync(root);
  return real === root ? [root] : [root, real];
}

/** The parts of the resolved config that decide whether a build is strict. */
export type BuildMode = Pick<ResolvedConfig, "command"> & {
  build?: Pick<ResolvedConfig["build"], "watch">;
};

/**
 * Whether buildEnd asserts the counts: `vite build` only. vitest and the dev
 * server run as "serve", and a watch build re-transforms changed files only.
 */
export function isStrictBuild(config: BuildMode): boolean {
  return config.command === "build" && !config.build?.watch;
}

function isOverlayImporter(importer: string, roots: string[]): boolean {
  const file = projectPath(importer.split("?")[0], roots);
  return file !== null && file.startsWith(OVERLAY_DIR);
}

export function sovtech(): Plugin {
  let roots: string[] = [];
  let strict = false;
  let audited = false;
  let rows: ShadowRow[] = [];
  let targets: ShadowTarget[] = [];
  const counts = new Map<string, number>();
  const count = (key: string, n: number) => {
    counts.set(key, (counts.get(key) ?? 0) + n);
  };

  return {
    name: "sovtech",
    enforce: "pre",
    config: {
      order: "pre",
      handler() {
        return {
          define: { __APP_NAME__: JSON.stringify(APP_NAME) },
          build: { sourcemap: "hidden" },
        };
      },
    },
    configResolved(config) {
      roots = rootsOf(config.root);
      strict = isStrictBuild(config);
      const mapFile = resolve(config.root, SHADOW_MAP);
      rows = parseShadowMap(readFileSync(mapFile, "utf8"));
      targets = shadowTargets(rows, config.root);
    },
    buildStart() {
      counts.clear();
      audited = false;
      for (const target of targets) {
        for (const file of [target.upstream, target.overlay]) {
          if (!existsSync(file)) {
            this.error(`${SHADOW_MAP} names a missing file: ${file}`);
          }
        }
      }
    },
    resolveId: {
      order: "pre",
      async handler(source, importer, options) {
        const resolveUpstream = () => {
          return this.resolve(source, importer, {
            attributes: options.attributes,
            custom: options.custom,
            isEntry: options.isEntry,
            skipSelf: true,
          });
        };
        const target = await resolveShadow(
          targets,
          roots,
          source,
          importer,
          resolveUpstream,
        );
        if (!target) return null;
        count(target.key, 1);
        return target.overlay;
      },
    },
    transform: {
      order: "pre",
      handler(code, id) {
        const file = scopedPath(id, roots);
        if (file === null) return null;
        const result = rewriteSource(code, file);
        for (const [key, n] of result.hits) count(key, n);
        if (result.code === code) return null;
        return { code: result.code, map: null };
      },
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        count(INDEX_HTML_KEY, 1);
        return rebrandIndexHtml(html);
      },
    },
    configureServer: {
      order: "pre",
      handler(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== `/${MANIFEST_FILE}`) {
            next();
            return;
          }
          res.setHeader("Content-Type", "application/manifest+json");
          res.end(MANIFEST_JSON);
        });
      },
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const existing = bundle[MANIFEST_FILE];
        if (existing === undefined) {
          this.emitFile({
            type: "asset",
            fileName: MANIFEST_FILE,
            source: MANIFEST_JSON,
          });
        } else if (existing.type === "asset") {
          existing.source = MANIFEST_JSON;
        } else {
          this.error(`${MANIFEST_FILE} is a chunk, not an asset`);
        }
      },
    },
    buildEnd(error) {
      if (error || !strict) return;
      const problems = auditCounts(counts, rows);
      if (problems.length > 0) {
        this.error(`SovTech overlay: ${problems.join("; ")}`);
      }
      audited = true;
      // Straight to stdout: `vite build -l error` drops this.info.
      process.stdout.write(`${auditSummary(rows)}\n`);
    },
    // Rollup renders chunks after buildEnd, and "post" runs after the
    // minifier. map: null keeps the source map, which an append leaves exact.
    renderChunk: {
      order: "post",
      handler(code, chunk) {
        if (!audited || !chunk.isEntry) return null;
        return { code: withAuditedMark(code), map: null };
      },
    },
  };
}
