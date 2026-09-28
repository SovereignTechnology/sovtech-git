/**
 * The export-shape contract of each shadowed pair (ci/sovtech/shadow-map.tsv),
 * checked by tsc and by nothing at run time.
 *
 * vite-plugin.ts swaps every import of an upstream shell module for its
 * overlay, so a runtime test would get the overlay on both sides. tsc does
 * not know about the swap: it resolves the upstream paths below to upstream's
 * files. Each pair must export the same names, and each export must be
 * assignable both ways (so the overlays take no props upstream's do not).
 * When upstream changes an export, `tsc --noEmit` fails here.
 */
import type * as UpstreamAppHeader from "@/components/AppHeader";
import type * as UpstreamAppFooter from "@/components/AppFooter";
import type * as UpstreamLandingPage from "@/pages/LandingPage";
import type * as UpstreamAbout from "@/pages/About";
import type * as UpstreamNotFound from "@/pages/NotFound";
import type * as UpstreamOgImagePreview from "@/pages/OgImagePreview";
import type * as OverlayAppHeader from "@/sovtech/overlays/AppHeader";
import type * as OverlayAppFooter from "@/sovtech/overlays/AppFooter";
import type * as OverlayLandingPage from "@/sovtech/overlays/LandingPage";
import type * as OverlayAbout from "@/sovtech/overlays/About";
import type * as OverlayNotFound from "@/sovtech/overlays/NotFound";
import type * as OverlayOgImagePreview from "@/sovtech/overlays/OgImagePreview";

/** [A assignable to B, B assignable to A]. */
type Mutual<A, B> = [
  [A] extends [B] ? true : false,
  [B] extends [A] ? true : false,
];

/** Per export name: Mutual for a shared name, [false, false] otherwise. */
type ExportsMatch<U, O> = {
  [K in keyof U | keyof O]: K extends keyof U & keyof O
    ? Mutual<U[K], O[K]>
    : [false, false];
};

/** The union over every export name of a pair. */
type Pair<U, O> = ExportsMatch<U, O>[keyof U | keyof O];

/** Compiles only when every member of the union is [true, true]. */
type Holds<T extends [true, true]> = T;

export type ShellContract = [
  Holds<Pair<typeof UpstreamAppHeader, typeof OverlayAppHeader>>,
  Holds<Pair<typeof UpstreamAppFooter, typeof OverlayAppFooter>>,
  Holds<Pair<typeof UpstreamLandingPage, typeof OverlayLandingPage>>,
  Holds<Pair<typeof UpstreamAbout, typeof OverlayAbout>>,
  Holds<Pair<typeof UpstreamNotFound, typeof OverlayNotFound>>,
  Holds<Pair<typeof UpstreamOgImagePreview, typeof OverlayOgImagePreview>>,
];
