# SovTech Git

SovTech Git is Sovereign Technology's build of
[GitWorkshop](https://gitworkshop.dev), the NIP-34 git-over-Nostr web client
by DanConwayDev. It is served at <https://git.sovtech.pro> and
<https://git.sovit.xyz>.

The fork re-brands the app (theme, header, footer, landing, about, 404, OG
image) and points its defaults at SovTech infrastructure, while leaving
upstream features untouched. The whole design exists to keep upstream merges
cheap.

## Lineage and licence

- Upstream: `nostr://npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/relay.ngit.dev/gitworkshop`.
  The GitHub copy (`DanConwayDev/gitworkshop`) is a stale mirror: never sync
  from it.
- Upstream is MIT (`LICENSE.md`, copyright DanConwayDev). That notice stays.
  SovTech's own changes are also MIT; see `NOTICE.md`.
- The fork base is recorded in `ci/sovtech/UPSTREAM_BASE`.

## Repositories and remotes

- `origin`: GitLab `sovtech/git` (private, canonical). All work lands here
  through MRs.
- GitHub `SovereignTechnology/sovtech-git`: a public, read-only push mirror of
  GitLab `main` and `sovtech-v*` tags.
- `nostr`: the NIP-34 announcement `sovtech-git` under the SovTech npub, a
  subordinate fork of upstream.
- `upstream`: Dan's repository, fetched over `nostr://`, never pushed to.
- `offbox`: the bare backup on ubuntu-server.

## How the overlay works

- New code lives in `src/sovtech/**` and `ci/sovtech/**`.
- Upstream files are touched only at small, cold seams, each listed with a line
  budget in `ci/sovtech/touched-upstream.txt`.
- Shell components are swapped in at build time by a Vite plugin
  (`src/sovtech/vite-plugin.ts`) that shadows upstream modules. Each shadowed
  file's upstream blob is recorded in `ci/sovtech/shadow-map.tsv`, so the sync
  shows exactly what upstream changed there.
- Branding copy in files we must not edit is rewritten at build time by rules
  that must match at least once, and the build fails if upstream branding
  survives in `dist`.

These pieces arrive in the MRs that follow this one.

## Upstream sync

`ci/sovtech/sync-upstream.sh` (weekly, or ad hoc for security fixes):

1. Fetch upstream over `nostr://` and cross-check `main` on two GRASP servers.
2. Refuse unless the new head descends from `UPSTREAM_BASE` and the history has
   a single root.
3. Merge with `--no-ff` on `sync/upstream-<sha8>`, re-delete the paths in
   `ci/sovtech/fork-deleted.txt`, and stop for a person on any real conflict.
4. Print the drift report for shadowed and watched files.
5. Bump `UPSTREAM_BASE` and open the MR with the `upstream-sync` label.

Sync MRs are merge commits: never squash or rebase them.

## Checks before every push

- The gate (`ci/sovtech/gate.sh`) runs in CI on fresh VMs: upstream's own
  `pnpm test`, the overlay guard, the brand-leak ratchet and secret scans.
- Before pushing, run the `differential-review` and `sharp-edges` audits on the
  diff and confirm fork commits carry the SovTech identity and no attribution
  trailers.

## Deployment

Releases (`sovtech-v*` tags) build a deterministic artifact in CI. Cameron
deploys it from the laptop to the `git-web` guest on l5400 with
`kata/ngit-grasp/deploy-spa.sh` in the `sovtech/l5400` repository.
