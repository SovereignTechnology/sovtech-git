/**
 * Every URL and route the SovTech shell adds, in one place.
 *
 * Links to the app itself are relative: git.sovtech.pro and git.sovit.xyz
 * share one web root, so no link names a host. Documentation links stay on
 * upstream's DOCUMENTATION_URLS (ngit.dev); SovTech hosts no docs.
 */
import { nip19 } from "nostr-tools";

/** The SovTech npub (npub1s0vtech…9adx) as hex. */
export const SOVTECH_PUBKEY =
  "83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434";

/** The d-tag of SovTech Git's own repository announcement. */
export const SOVTECH_GIT_IDENTIFIER = "sovtech-git";

/**
 * Relay hints for that announcement. They follow the relays the phase 4
 * announcement uses; until it exists, the links below show upstream's
 * not-found state.
 */
export const SOVTECH_GIT_RELAYS: readonly string[] = Object.freeze([
  "wss://git.sovit.xyz",
  "wss://relay.ngit.dev",
]);

/** The announcement's address, 30617:<SovTech hex>:sovtech-git. */
export const SOVTECH_GIT_NADDR = nip19.naddrEncode({
  kind: 30617,
  pubkey: SOVTECH_PUBKEY,
  identifier: SOVTECH_GIT_IDENTIFIER,
  relays: [...SOVTECH_GIT_RELAYS],
});

/** SovTech Git's repository and its issues, in this app. */
export const SOVTECH_GIT_PATH = `/${SOVTECH_GIT_NADDR}`;
export const SOVTECH_GIT_ISSUES_PATH = `/${SOVTECH_GIT_NADDR}/issues`;

/**
 * Upstream's repository (DanConwayDev's gitworkshop) in this app. It is a
 * literal npub, never assembled at run time, so the brand ratchet counts it:
 * brand-allowlist.json lists it as functional attribution ("dan-npub").
 */
export const UPSTREAM_REPO_PATH =
  "/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/gitworkshop";

/** The lineage section of the About page. */
export const LINEAGE_PATH = "/about#lineage";

/** The licence: a static file in public/, not a router route. */
export const LICENSE_PATH = "/LICENSE.txt";

export const SOVTECH_WWW_URL = "https://www.sovtech.pro";
export const GITHUB_MIRROR_URL =
  "https://github.com/SovereignTechnology/sovtech-git";
export const NIP34_URL = "https://nips.nostr.com/34";

export interface OtherClient {
  name: string;
  /** An in-app path (a leading "/") or a full URL. */
  href: string;
}

/** Other NIP-34 clients, with upstream About's targets. */
export const OTHER_CLIENTS: readonly OtherClient[] = Object.freeze([
  {
    name: "n34",
    href: "/npub1qqqqqq2stely3ynsgm5mh2nj3v0nk5gjyl3zqrzh34hxhvx806usxmln03/nostr.4rs.nl/n34",
  },
  { name: "budabit", href: "https://budabit.club" },
  {
    name: "gitplaza",
    href: "/npub1useke4f9maul5nf67dj0m9sq6jcsmnjzzk4ycvldwl4qss35fvgqjdk5ks/gitplaza",
  },
  { name: "shakespeare", href: "https://shakespeare.diy" },
]);
