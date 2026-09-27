/**
 * SovTech Git defaults: the relay, GRASP and host lists the fork ships in
 * place of upstream's.
 *
 * Upstream modules import these at small seams (listed in
 * ci/sovtech/touched-upstream.txt): src/services/settings.ts,
 * src/actions/account.ts, src/lib/gitworkshopUrl.ts and
 * src/lib/repoUpstreamInput.ts. An upstream sync then conflicts only where
 * upstream changed one of these lists itself, which is exactly when a person
 * should look.
 *
 * The lists add SovTech infrastructure first and keep the wider Nostr
 * ecosystem. They never name nos.lol or nostr.mom, which are banned on the
 * SovTech estate; src/sovtech/defaults.test.ts enforces that for every
 * default list the app ships.
 *
 * Every list is frozen: WEB_HOSTS decides which links open in-app, and no
 * caller should be able to change a default for the rest of the app.
 *
 * Deliberately left at upstream's values, for discoverability and interop
 * with every other NIP-34 client:
 *   - the git index relay (wss://index.ngit.dev), where ngit and other
 *     clients find repository announcements, so repositories published from
 *     SovTech Git stay discoverable everywhere;
 *   - the lookup relays, where profiles and relay lists are indexed;
 *   - the Blossom servers (src/lib/blossom.ts) and the CORS proxy
 *     (src/lib/git-grasp-pool/cors-proxy.ts), so media and git data hosted
 *     elsewhere load exactly as they do in upstream.
 */

/**
 * Fallback relays, used when no better relay source is known. They are
 * publish targets as well as read targets. SovTech's GRASP pair comes first,
 * then large public relays.
 */
export const FALLBACK_RELAYS: readonly string[] = Object.freeze([
  "wss://git.sovit.xyz",
  "wss://git.buildinelsalvador.com",
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.ditto.pub",
  "wss://offchain.pub",
]);

/**
 * GRASP service addresses offered when a user has no kind:10317 list, in
 * upstream's scheme-less form. SovTech's pair comes first; relay.ngit.dev
 * keeps a third, independent copy, since invitation acceptance backfills to
 * three servers.
 */
export const GRASP_SERVERS: readonly string[] = Object.freeze([
  "git.sovit.xyz",
  "git.buildinelsalvador.com",
  "relay.ngit.dev",
]);

/**
 * NIP-46 (nostrconnect) rendezvous relays for new remote-signer logins:
 * upstream's list, with nos.lol replaced by relay.nos.social.
 */
export const NOSTR_CONNECT_RELAYS: readonly string[] = Object.freeze([
  "wss://bucket.coracle.social",
  "wss://relay.nos.social",
  "wss://relay.ditto.pub",
  "wss://relay.primal.net",
  "wss://nrs.primal.net",
]);

/**
 * Relays a newly created account is bootstrapped onto (its first NIP-65
 * relay list, read and write): upstream's list, with nos.lol replaced by
 * relay.primal.net.
 */
export const BOOTSTRAP_RELAYS: readonly string[] = Object.freeze([
  "wss://relay.ditto.pub",
  "wss://relay.damus.io",
  "wss://relay.primal.net",
]);

/**
 * Hosts that serve SovTech Git. Links to them are recognised alongside
 * upstream's own host, which stays recognised too.
 */
export const WEB_HOSTS: readonly string[] = Object.freeze([
  "git.sovtech.pro",
  "git.sovit.xyz",
]);

/** Whether a host name (any case, no port) is one that serves SovTech Git. */
export function isSovtechWebHost(host: string | undefined): boolean {
  return host !== undefined && WEB_HOSTS.includes(host.toLowerCase());
}
