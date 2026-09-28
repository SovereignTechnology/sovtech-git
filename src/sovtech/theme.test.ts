import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import colors from "tailwindcss/colors.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_STEPS, sovtechTheme } from "@/sovtech/tailwind-brand";

/*
 * These tests hold the variable sets and the import order. The gate holds
 * the rest, outside any dependency code: the digest of upstream's palette
 * (ci/sovtech/upstream-palette.sha256, history phase) and theme.css's place
 * in the built CSS (overlay_guard.py theme-css-order, dist phase).
 */
const PALETTE_BLOCK = /(^|\s)(:root|\.dark)\s*\{([^}]*)\}/g;
const VARIABLE_NAME = /--([\w-]+)\s*:/g;
const SIDE_EFFECT_IMPORT = /^import\s+"([^"]+)";$/gm;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readRepoFile(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

interface PaletteBlock {
  selector: string;
  body: string;
}

function paletteBlocks(css: string): PaletteBlock[] {
  const blocks: PaletteBlock[] = [];
  for (const match of css.matchAll(PALETTE_BLOCK)) {
    blocks.push({ selector: match[2], body: match[3] });
  }
  return blocks;
}

function variableNames(body: string): string[] {
  return Array.from(body.matchAll(VARIABLE_NAME), (match) => match[1]).sort();
}

describe("theme.css", () => {
  const upstream = paletteBlocks(readRepoFile("src/index.css"));
  const theme = paletteBlocks(readRepoFile("src/sovtech/theme.css"));
  const brandSteps = BRAND_STEPS.map((step) => `brand-${step}`);
  const brandNames = [...brandSteps, "brand-foreground"].sort();

  it("redefines exactly upstream's variables in each block, plus the brand scale", () => {
    expect(upstream.map((block) => block.selector)).toEqual([":root", ".dark"]);
    expect(theme.map((block) => block.selector)).toEqual([":root", ".dark"]);
    theme.forEach((block, index) => {
      const names = variableNames(block.body);
      expect(names.filter((name) => !name.startsWith("brand-"))).toEqual(
        variableNames(upstream[index].body),
      );
      expect(names.filter((name) => name.startsWith("brand-"))).toEqual(
        brandNames,
      );
    });
  });

  it("is the last stylesheet main.tsx imports", () => {
    const source = readRepoFile("src/main.tsx");
    const matches = source.matchAll(SIDE_EFFECT_IMPORT);
    const imports = Array.from(matches, (match) => match[1]);
    expect(imports).toContain("./index.css");
    expect(imports.at(-1)).toBe("@/sovtech/theme.css");
  });
});

describe("tailwind-brand", () => {
  it("points every pink step at its brand variable with an alpha slot", () => {
    expect(Object.keys(sovtechTheme.colors.pink)).toEqual(
      BRAND_STEPS.map(String),
    );
    for (const step of BRAND_STEPS) {
      expect(sovtechTheme.colors.pink[step]).toBe(
        `hsl(var(--brand-${step}) / <alpha-value>)`,
      );
    }
  });

  it("names the same scale brand, with brand itself at step 500", () => {
    const brand = sovtechTheme.colors.brand;
    expect(brand.DEFAULT).toBe("hsl(var(--brand-500) / <alpha-value>)");
    for (const step of BRAND_STEPS) {
      expect(brand[step]).toBe(sovtechTheme.colors.pink[step]);
    }
  });

  it("maps amber to yellow, leaves rose alone and applies Inter", () => {
    expect(sovtechTheme.colors.amber).toEqual(colors.yellow);
    expect(sovtechTheme.colors).not.toHaveProperty("rose");
    expect(sovtechTheme.fontFamily.sans[0]).toBe('"Inter Variable"');
  });
});

describe("dark by default", () => {
  const originalMatchMedia = window.matchMedia;

  function mediaQueryList(query: string, dark: boolean): MediaQueryList {
    const list = {
      matches: dark && query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    return list as unknown as MediaQueryList;
  }

  function setOsDark(dark: boolean) {
    window.matchMedia = vi.fn((query: string) => mediaQueryList(query, dark));
  }

  function isDark(): boolean {
    return document.documentElement.classList.contains("dark");
  }

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  describe("public/theme-init.js", () => {
    const themeInit = new Function(readRepoFile("public/theme-init.js"));

    function initialDark(stored: string | null, osDark: boolean): boolean {
      document.documentElement.classList.remove("dark");
      localStorage.clear();
      localStorage.setItem("themeMigratedV2", "1");
      if (stored !== null) localStorage.setItem("theme", stored);
      setOsDark(osDark);
      themeInit();
      return isDark();
    }

    it("paints dark when no theme is stored", () => {
      expect(initialDark(null, false)).toBe(true);
    });

    it("honours an explicit light, dark or system choice", () => {
      expect(initialDark("light", true)).toBe(false);
      expect(initialDark("dark", false)).toBe(true);
      expect(initialDark("system", false)).toBe(false);
      expect(initialDark("system", true)).toBe(true);
    });

    it("treats an unknown value as dark", () => {
      expect(initialDark("sepia", false)).toBe(true);
    });
  });

  describe("settings theme mode", () => {
    async function loadSettings() {
      vi.resetModules();
      return import("@/services/settings");
    }

    it("defaults to dark and stores only a non-default choice", async () => {
      setOsDark(false);
      const settings = await loadSettings();
      expect(settings.themeMode.getValue()).toBe("dark");
      expect(isDark()).toBe(true);
      expect(localStorage.getItem("theme")).toBeNull();

      settings.setThemeMode("system");
      expect(localStorage.getItem("theme")).toBe("system");
      expect(isDark()).toBe(false);

      settings.setThemeMode("dark");
      expect(localStorage.getItem("theme")).toBeNull();
      expect(isDark()).toBe(true);
    });

    it("keeps a stored system choice", async () => {
      localStorage.setItem("theme", "system");
      setOsDark(true);
      const settings = await loadSettings();
      expect(settings.themeMode.getValue()).toBe("system");
      expect(localStorage.getItem("theme")).toBe("system");
      expect(isDark()).toBe(true);
    });
  });
});
