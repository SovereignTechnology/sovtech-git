/**
 * SovTech Git's additions to Tailwind's theme. tailwind.config.ts (an upstream
 * seam) spreads them into `theme.extend`.
 *
 * - `pink`: upstream's accent is written as literal pink-* classes, so the
 *   whole scale points at the theme-aware `--brand-*` variables in theme.css.
 *   The `<alpha-value>` slot keeps opacity modifiers such as `bg-pink-500/10`
 *   working.
 * - `brand`: the same scale under the fork's own name, with a DEFAULT at step
 *   500 (#F7931A in dark mode), so fork code writes semantic classes such as
 *   `text-brand`, `border-brand/30` and `bg-brand/10` instead of pink-*.
 * - `amber`: Tailwind's yellow values, so warnings stay distinct from the
 *   orange brand.
 * - `rose` is not remapped: it is a label colour bucket.
 * - `fontFamily.sans`: the self-hosted Inter Variable, which upstream imports
 *   in main.tsx but never applies. `fontFamily.heading`: the system mono
 *   stack for headings, so no new font dependency.
 *
 * Tailwind's config loader (Node's own TypeScript support, with jiti as its
 * fallback), Vite and tsc all load this file: keep it to erasable TypeScript
 * (no enums or namespaces, `import type` for types) and give Tailwind's
 * subpath imports their `.js` extension, which Node's ESM resolver needs.
 */
import colors from "tailwindcss/colors.js";
import defaultTheme from "tailwindcss/defaultTheme.js";

export const BRAND_STEPS = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;

function brandColor(step: number): string {
  return `hsl(var(--brand-${step}) / <alpha-value>)`;
}

const brandScale: Record<string, string> = Object.fromEntries(
  BRAND_STEPS.map((step) => [step, brandColor(step)]),
);

const brandAlias: Record<string, string> = {
  DEFAULT: brandColor(500),
  ...brandScale,
};

const defaultSans: string[] = defaultTheme.fontFamily.sans;
const defaultMono: string[] = defaultTheme.fontFamily.mono;

export const sovtechTheme = {
  colors: {
    pink: brandScale,
    brand: brandAlias,
    amber: colors.yellow,
  },
  fontFamily: {
    sans: ['"Inter Variable"', ...defaultSans],
    heading: [...defaultMono],
  },
};
