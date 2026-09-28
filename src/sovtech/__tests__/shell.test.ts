/**
 * The shell overlays against the upstream files they shadow: the shadow map
 * rows, the link and component parity of the header and footer, and the
 * addresses in src/sovtech/links.ts. The export shapes are held by tsc, in
 * src/sovtech/contract.ts: vitest itself gets the overlay for both sides.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  SOVTECH_GIT_ISSUES_PATH,
  SOVTECH_GIT_NADDR,
  SOVTECH_GIT_PATH,
  SOVTECH_PUBKEY,
  UPSTREAM_REPO_PATH,
} from "@/sovtech/links";

const root = process.cwd();
const SHADOW_MAP = "ci/sovtech/shadow-map.tsv";
const WAIVERS = "src/sovtech/overlays/parity-waivers.tsv";
const SHELL = [
  "AppHeader",
  "AppFooter",
  "LandingPage",
  "About",
  "NotFound",
  "OgImagePreview",
];
const PARITY = ["AppHeader", "AppFooter"];

function read(file: string): string {
  return readFileSync(resolve(root, file), "utf8");
}

/** The data rows of a header-first TSV, without blank and comment lines. */
function tsvRows(text: string): string[][] {
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  return lines.slice(1).map((line) => line.split("\t"));
}

interface ShadowEntry {
  upstreamPath: string;
  overlayPath: string;
  ackedBlob: string;
  sentinel: string;
  marker: string;
}

function shadowEntries(): ShadowEntry[] {
  return tsvRows(read(SHADOW_MAP)).map(
    ([upstreamPath, overlayPath, ackedBlob, sentinel, marker]) => ({
      upstreamPath,
      overlayPath,
      ackedBlob,
      sentinel,
      marker,
    }),
  );
}

function shadowEntry(name: string): ShadowEntry {
  const entry = shadowEntries().find(
    (row) => row.overlayPath === `src/sovtech/overlays/${name}.tsx`,
  );
  if (!entry) throw new Error(`${SHADOW_MAP} has no row for ${name}`);
  return entry;
}

/** git's blob id for a file's bytes. */
function blobId(file: string): string {
  const bytes = readFileSync(resolve(root, file));
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

/** Every source file under dir, as a root-relative path. */
function sourceFiles(dir: string): string[] {
  const entries = readdirSync(resolve(root, dir), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?|css|html)$/.test(entry.name) ? [path] : [];
  });
}

// --- link and component parity ---------------------------------------------

const IMPORT = /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"[^"]+";/gm;
/** to="…" and href="…", or to={…} and href={…} without nested braces. */
const JSX_TARGET = /\b(?:to|href)=(?:"([^"]*)"|\{([^{}]*)\})/g;
/** to: … and href: … in object literals, such as a nav table. */
const PROP_TARGET = /\b(?:to|href):\s*("[^"]*"|[\w.]+)/g;
const NAVIGATE = /\bnavigate\(([^;]*)\);/g;
const LITERAL = /"([^"]*)"|`([^`]*)`/g;
const JSX_TAG = /<([A-Z]\w*)[\s/>]/g;

/** The names a module imports with named imports. */
function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(IMPORT)) {
    for (const part of match[1].split(",")) {
      // "Name", "type Name" or "Name as Alias": the local name is last.
      const name = part.trim().split(/\s+/).at(-1);
      if (name && name !== "type") names.add(name);
    }
  }
  return names;
}

/** A template literal with its substitutions blanked, as `/x?q=${}`. */
function template(body: string): string {
  return `\`${body.replace(/\$\{[^}]*\}/g, "${}")}\``;
}

function literals(expression: string): string[] {
  return Array.from(expression.matchAll(LITERAL), (match) =>
    match[1] !== undefined ? match[1] : template(match[2]),
  );
}

/**
 * Where a module links to: string and template literals, and member
 * expressions of an imported constant (DOCUMENTATION_URLS.install). An
 * expression rooted in a local (link.to) is an indirection; the object
 * property it reads is found on its own.
 */
function linkTargets(source: string): Set<string> {
  const imported = importedNames(source);
  const targets = new Set<string>();
  const add = (expression: string) => {
    const text = expression.trim();
    if (/^["`]/.test(text)) {
      for (const value of literals(text)) targets.add(value);
    } else if (imported.has(text.split(".")[0])) {
      targets.add(text);
    }
  };
  for (const match of source.matchAll(JSX_TARGET)) {
    if (match[1] !== undefined) targets.add(match[1]);
    else add(match[2]);
  }
  for (const match of source.matchAll(PROP_TARGET)) add(match[1]);
  for (const match of source.matchAll(NAVIGATE)) {
    for (const value of literals(match[1])) targets.add(value);
  }
  return targets;
}

/** Imported components a module renders as JSX elements. */
function jsxComponents(source: string): Set<string> {
  const imported = importedNames(source);
  const used = new Set<string>();
  for (const match of source.matchAll(JSX_TAG)) {
    if (imported.has(match[1])) used.add(match[1]);
  }
  return used;
}

/** What an overlay lacks of its upstream file, as "kind value" keys. */
function parityGaps(name: string): string[] {
  const entry = shadowEntry(name);
  const upstream = read(entry.upstreamPath);
  const overlay = read(entry.overlayPath);
  const gaps: string[] = [];
  const targets = linkTargets(overlay);
  for (const target of linkTargets(upstream)) {
    if (!targets.has(target)) gaps.push(`target ${target}`);
  }
  const components = jsxComponents(overlay);
  for (const component of jsxComponents(upstream)) {
    if (!components.has(component)) gaps.push(`component ${component}`);
  }
  return gaps;
}

function waiverKeys(): Set<string> {
  const rows = tsvRows(read(WAIVERS));
  for (const row of rows) {
    expect(row).toHaveLength(4);
    expect(PARITY).toContain(row[0]);
    expect(row[3].trim()).not.toBe("");
  }
  return new Set(rows.map(([name, kind, key]) => `${name} ${kind} ${key}`));
}

// --- tests -----------------------------------------------------------------

describe("shadow map", () => {
  const entries = shadowEntries();

  it("maps the six shell modules to overlays of the same name", () => {
    expect(entries.map((entry) => entry.overlayPath)).toEqual(
      SHELL.map((name) => `src/sovtech/overlays/${name}.tsx`),
    );
    for (const entry of entries) {
      const name = basename(entry.overlayPath, ".tsx");
      expect(basename(entry.upstreamPath, ".tsx")).toBe(name);
      expect(entry.sentinel).toBe(`sovtech.overlay.${name}`);
    }
  });

  it("acks each upstream file as this tree holds it", () => {
    for (const entry of entries) {
      expect(blobId(entry.upstreamPath)).toBe(entry.ackedBlob);
    }
  });

  it("sets each sentinel in its overlay at module scope", () => {
    for (const entry of entries) {
      const key = JSON.stringify(entry.sentinel);
      expect(read(entry.overlayPath)).toContain(
        `\nReflect.set(globalThis, Symbol.for(${key}), true);\n`,
      );
    }
  });

  // Reads each of the ~560 files once, not once per row: on the CI runners'
  // idle-priority CPU the per-row reads outran vitest's 5 s default.
  it("uses markers that only their upstream file holds", () => {
    const files = [...sourceFiles("src"), "index.html"].map((file) => ({
      file,
      text: read(file),
    }));
    for (const entry of entries) {
      const found = files
        .filter(({ text }) => text.includes(entry.marker))
        .map(({ file }) => file);
      expect(found).toEqual([entry.upstreamPath]);
    }
  }, 30_000);
});

describe("header and footer parity", () => {
  it("parses every to= and href= attribute upstream writes", () => {
    for (const name of PARITY) {
      const source = read(shadowEntry(name).upstreamPath);
      const written = source.match(/\b(?:to|href)=/g) ?? [];
      expect([...source.matchAll(JSX_TARGET)]).toHaveLength(written.length);
    }
  });

  it("reads upstream's link targets and components", () => {
    const header = read(shadowEntry("AppHeader").upstreamPath);
    expect([...linkTargets(header)].sort()).toEqual(
      ["/", "/search", "/settings", "`/search?q=${}`"].sort(),
    );
    expect([...jsxComponents(header)]).toContain("CreateRepoDialog");
    const footer = read(shadowEntry("AppFooter").upstreamPath);
    expect([...linkTargets(footer)].sort()).toEqual(
      [
        "/",
        "/about",
        "/landing",
        "/search",
        "DOCUMENTATION_URLS.install",
        "DOCUMENTATION_URLS.quickstart",
      ].sort(),
    );
    expect([...jsxComponents(footer)].sort()).toEqual(["Button", "Link"]);
  });

  it.each(PARITY)("keeps what upstream %s links to and renders", (name) => {
    const waived = waiverKeys();
    const gaps = parityGaps(name).filter(
      (gap) => !waived.has(`${name} ${gap}`),
    );
    expect(gaps).toEqual([]);
  });

  it("waives only what an overlay lacks", () => {
    const gaps = new Set<string>();
    for (const name of PARITY) {
      for (const gap of parityGaps(name)) gaps.add(`${name} ${gap}`);
    }
    expect([...waiverKeys()].filter((key) => !gaps.has(key))).toEqual([]);
  });
});

describe("links", () => {
  it("addresses SovTech Git's repository announcement", () => {
    const decoded = nip19.decode(SOVTECH_GIT_NADDR);
    expect(decoded.type).toBe("naddr");
    const { kind, pubkey, identifier, relays } = decoded.data;
    expect(`${kind}:${pubkey}:${identifier}`).toBe(
      `30617:${SOVTECH_PUBKEY}:sovtech-git`,
    );
    expect(relays).toEqual(["wss://git.sovit.xyz", "wss://relay.ngit.dev"]);
    expect(SOVTECH_GIT_PATH).toBe(`/${SOVTECH_GIT_NADDR}`);
    expect(SOVTECH_GIT_ISSUES_PATH).toBe(`/${SOVTECH_GIT_NADDR}/issues`);
  });

  it("uses the SovTech key", () => {
    expect(nip19.npubEncode(SOVTECH_PUBKEY)).toBe(
      "npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx",
    );
  });

  it("links upstream's gitworkshop repository by its npub", () => {
    const [npub, repo, ...rest] = UPSTREAM_REPO_PATH.slice(1).split("/");
    expect(nip19.decode(npub).type).toBe("npub");
    expect(repo).toBe("gitworkshop");
    expect(rest).toEqual([]);
  });
});
