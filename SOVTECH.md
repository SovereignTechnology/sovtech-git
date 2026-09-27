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

`ci/sovtech/sync-upstream.sh` (weekly, or ad hoc for security fixes; Cameron
runs it from a clean checkout):

1. Assert the `upstream` remote is Dan's npub over `nostr://` with push
   `DISABLED`, fetch upstream `main` and `origin/main`, and cross-check
   `refs/heads/main` on gitnostr.com and relay.ngit.dev.
2. Take the rules (`sync_checks.py`, `sovci.py`) from the fork head with
   `git archive`, refusing any `__pycache__` entry or `.pyc` file, prove each
   file byte-identical to its blob, and run them with `python3 -I`. Nothing
   from the tree being merged ever runs on the laptop.
3. Refuse unless the new head descends from `UPSTREAM_BASE` and the history has
   the single root `19dd6a87`.
4. Refuse any upstream add, change or delete of a fork-owned path
   (`ci/sovtech/`, `src/sovtech/`, `SOVTECH.md`, `NOTICE.md`,
   `CHANGELOG.sovtech.md`, `CLAUDE.md`, `.gitlab-ci.yml`, `renovate.json`),
   with no allowlist. Refuse new or changed agent and editor configuration
   (deny-by-default, acked per blob in `ci/sovtech/agent-config-allow.txt`),
   flag `AGENTS.md` changes for a person, and list the security-sensitive
   paths to review. Every upstream path and diff line is printed with
   non-printable characters escaped.
5. Merge with `--no-ff` as `sovtech <git@sovit.xyz>` on
   `sync/upstream-<sha8>` (git's merge output, which names upstream paths, is
   printed with non-printable characters escaped), re-delete the paths in
   `ci/sovtech/fork-deleted.txt` as literal paths (entries may not hold `*`,
   `?`, `[`, `\` or `:`), and stop for a person on any real conflict.
6. Prove every fork-owned path still equals the fork head's, print the drift
   report for shadowed and watched files, bump `UPSTREAM_BASE` as `sovITxyz`,
   and print the push command that opens the MR with the `upstream-sync` label
   (`--push` runs it).

`--finish` resumes after a person committed the merge. It fetches again and
re-runs steps 1 to 4: upstream `main` and `origin/main` must still be the
merge's parents 2 and 1, and the branch name must be `sync/upstream-` plus the
first 8 hex digits of that upstream head. If either moved, regenerate the
branch.

`--report-only` is the weekly CI drift job: the same fetch and checks, a trial
merge in a throwaway worktree, and the report. It changes nothing. CI runners
have no nostr helper, so it fetches from the two GRASP https URLs and requires
them to agree.

Sync MRs are merge commits: never squash or rebase them.

## CI and the gate

`.gitlab-ci.yml` runs every job in a fresh Kata VM. No job uses CI/CD
variables or secrets. Routing comes from ref protection alone. Every
`workflow:rules` entry that creates a pipeline sets `SOVGIT_RUNNER_TAG`: to
the protected runner's tag exactly when it requires
`$CI_COMMIT_REF_PROTECTED == "true"` (a push to `main`, `sovtech-v*` tags),
and to the unprotected runner's tag exactly when it requires
`$CI_COMMIT_REF_PROTECTED != "true"` (merge request events, the drift
schedule on `drift/weekly`). The last rule is `when: never`, so an
unprotected `main` or tag, or a merge request or drift schedule on a
protected ref, creates no pipeline. Every job inherits
`default: tags: [$SOVGIT_RUNNER_TAG]`; no job or template has `tags` or
`inherit`, and nothing else sets that variable or any `CI_*` variable. So
merge requests, sync MRs and the drift job run on `ci-sovgit`, and `main` and
`sovtech-v*` tags on `ci-sovgit-prot`, which takes protected refs only.

The gate's `ci-config` step checks this statically (below). The runbook,
`kata/ci-sovgit/README.md` in `sovtech/platform`, adds a pre-merge GitLab CI
Lint dry run with `ref=main` on a CI change's head (more than zero jobs,
every one tagged exactly the protected tag), and checks which runner the
first merge request pipeline ran on, since no dry run can simulate a merge
request pipeline.

- **guard:** `ci/sovtech/gate.sh --phase history`, before any dependency code
  runs.
- **verify:** Node 24 and pnpm 9.15.9 through corepack (both asserted),
  `pnpm install --frozen-lockfile`, upstream's `pnpm test`, then
  `gate.sh --phase dist` on the built `dist`.
- **recheck** (MRs and `main`): `gate.sh --phase recheck` on verify's `dist`
  artifact, in a job that never runs pnpm. verify's own dist gate ran after
  dependency install scripts, vite and vitest, so it is only self-reported.
- **e2e** (sync MRs and tags): upstream's e2e suites against ngit-grasp 3.0.0
  built with `cargo install --locked`. A missing or empty JUnit report, zero
  testcases or any skipped test fails the job.
- **package** (tags): `gate.sh --phase recheck --release` on the downloaded
  artifact first, then the tested `dist` as a deterministic tarball with
  `build-info.json` and `SHA256SUMS`; source maps are a separate artifact.
- **drift** (the weekly schedule on `drift/weekly`; the schedule on
  `drift/weekly` carries no variables): `sync-upstream.sh --report-only`.

The gate checks, all failing closed:

- **Identity:** every fork commit
  (`git rev-list TARGET..HEAD --not UPSTREAM_BASE`) is
  `sovITxyz <git@sovit.xyz>` as author and committer; only merge commits may
  be `sovtech <git@sovit.xyz>`, and none may have more than two parents
  (octopus merges are refused, see gitleaks below). No trailers, no
  attribution text, and no `hs.internal` identity anywhere in the push range.
- **Fork-owned base:** the `UPSTREAM_BASE` tree holds no fork-owned path, so
  no upstream commit can reach into the gate, and a fork commit cannot pose as
  the base. A control requires the same listing to see the gate at `HEAD`.
- **`UPSTREAM_BASE`:** it must be a parent of a fork commit, so it only moves
  with a sync merge, and only `sync/upstream-*` MRs may change it. It must be
  on upstream `main` as both GRASP servers publish it (fetched over https with
  no credentials; a failed fetch fails the check) whenever TARGET does not
  already vouch for it: a changed or new base, release mode, and CI runs
  without a TARGET.
- **Gate changes:** every changed path under `ci/sovtech/` and
  `.gitlab-ci.yml` against TARGET is printed as `REVIEW gate-change`. On a
  `sync/upstream-*` branch only the data files a sync updates may change
  (`UPSTREAM_BASE`, `shadow-map.tsv`, `brand-allowlist.json`,
  `touched-upstream.txt`, `asset-swaps.tsv`, `agent-config-allow.txt`, each
  staying a regular file); any change to the gate's code (`*.sh`, `*.py`,
  `tools.sha256`, `gitleaks.toml`, `.gitleaksignore`, `fork-deleted.txt`, any
  new file) or to `.gitlab-ci.yml` fails.
- **No bytecode:** `HEAD`'s `ci/sovtech` may hold no `__pycache__` entry and
  no `.pyc` file (in any case); a control proves the matcher first.
- **CI config** (`ci/sovtech/ci_config.py`, standard library only): the
  routing above, read with a strict YAML-subset parser that refuses anchors,
  tags, flow mappings and anything else it cannot read exactly. Each
  protected rule also pins `$CI_COMMIT_BRANCH == "main"` or a `sovtech-v`
  tag (neither exists in a merge request pipeline) and tests the pipeline
  source, if at all, only as `"push"`. The only `tags` key is the default; no
  `include`, `trigger`, `inherit`, `parallel` (a `parallel: matrix` entry
  sets job variables that tags expand) or `dotenv`; no other `variables`
  block sets `SOVGIT_RUNNER_TAG`, and none sets any `CI_*` key; the two tag
  literals appear only in the workflow rules. Mutated copies (a job tagged
  with the unprotected tag, a job matrix, a protected merge request rule, a
  missing final `when: never`, among others) must each fail first.
- **gitleaks:** pinned by sha256 in `ci/sovtech/tools.sha256`, checked before
  extraction, and run with `--config ci/sovtech/gitleaks.toml`: gitleaks
  8.30.1's default config (the `v8.30.1` tag's `config/gitleaks.toml`, the
  same bytes the pinned binary embeds) without the global allowlist entries
  for images, fonts, documents and `node_modules`. The lockfile entry
  (`pnpm-lock.yaml`, `package-lock.json` and the like) is kept on purpose:
  upstream's lockfiles change in every sync range and would only add noise.
  The scan is proven on planted tokens, on a file that `.gitattributes` marks
  `-diff`, on a conflicted merge whose resolution plants one, and on one
  token each in `x.svg` and `node_modules/a.js` (exactly two findings), then
  run over the push range with `--text --no-textconv --diff-merges=remerge`:
  `-diff` files (upstream marks `*.ts`) are scanned as text, and merge
  resolutions are scanned too (git 2.36 or later). Remerge diffs exist for
  two-parent merges only, which is why the identity check refuses octopus
  merges in the fork range. Inline `gitleaks:allow` comments are ignored:
  accepted findings go only in `ci/sovtech/.gitleaksignore`.
- **Overlay guard:** shadow-map acked blobs, sentinels and markers; the
  `touched-upstream.txt` numstat bound; `asset-swaps.tsv` blobs; deleted paths
  stay deleted; the CSP meta in `dist` is byte-identical to upstream's.
- **Brand-leak ratchet** over `dist` without source maps: upstream brand terms
  (the `GitWorkshop` name, and `gitworkshop.dev` both as a URL and as a bare
  host in any case), Dan's npub and hex key (also inside decoded bech32 TLVs),
  `nos.lol`, the manifest names and `og:url`. Counts must equal
  `ci/sovtech/brand-allowlist.json` exactly: `functional` entries are
  permanent, `pending` entries name the MR that removes them.
  `gate.sh --baseline` prints the counts that seed `pending`; `--release`
  requires `pending` to be empty and six shadow rows.
- **Dist secret scan** (maps included): Nostr secret keys, bunker secrets,
  GitLab, GitHub and AWS tokens and private-key blocks, reported by rule, file
  and byte offset only.
- Both dist scans fail on any symlink in `dist` or the maps, to a file or to
  a directory (a linked directory would otherwise go unscanned), and on a
  directory they cannot read; a planted symlink proves it on every run.

Every Python check runs as `python3 -I` (isolated mode: neither the script's
directory nor the working directory is on `sys.path`), so no file in the tree
can stand in for a standard-library module. Each script reads `sovci.py`'s
source, compiles it and runs it in a fresh module, without the import
system, so no `.pyc` is ever read: a planted
`ci/sovtech/__pycache__/sovci.cpython-3XX.pyc`, even an unchecked-hash one,
cannot stand in for it. The scripts refuse to run without `-I` (or below
Python 3.10), and check that before any import but the built-in `sys`, so
even a run without `-I` stops before a planted sibling such as `argparse.py`
could load.

Before pushing, also run the `differential-review` and `sharp-edges` audits on
the diff. `ci/sovtech/` is bash and Python 3 standard library only, so it can
be checked on the laptop without upstream code.

The gate still runs from the tree it checks: an MR that changes `gate.sh`
changes the checks it is held to, and `REVIEW gate-change` only makes that
visible. The stronger option, a follow-up for Cameron (no project setting has
changed): point project 88's CI/CD configuration file at a Maintainer-only
policy project whose pipeline extracts the gate from the MR's target branch
and runs that copy against the MR head, so an MR can never weaken its own
gate.

## Protected-runner token

Dependency code runs on the protected runner: `verify:main`,
`verify:release` and `e2e:release` run pnpm lifecycle scripts, vite, vitest,
tsc and cargo on `ci-sovgit-prot`. A malicious dependency could read that
runner's token there and later use it to take protected jobs.

Mitigation in force: rotate `ci-sovgit-prot`'s token after every sync MR
merge and after every release (`POST /runners/:id/reset_authentication_token`),
piping the new token straight to the server's 0600 token file and to
`secret-store`; it is never printed. This bounds a one-time read only:
`verify:main` runs the same lockfile's dependencies on every `main`
pipeline, so a poisoned dependency re-reads the new token at the next one.
The real bound is the clean runner below, or a rotation after every
protected pipeline.

A third, clean runner that takes only the guard, recheck and package jobs,
so no job that judges or ships the dist shares a token with dependency code,
is a possible hardening that Cameron may choose later.

The limit no rotation removes: a poisoned dependency can alter the built
`dist` itself. recheck runs where no dependency code ran, but it only
catches what the dist checks look for (brand and secret regressions), not a
malicious change to the app's code.

## Deployment

Releases (`sovtech-v*` tags) build a deterministic artifact in CI
(`sovtech-git-<tag>.tar.gz`, `build-info.json`, `SHA256SUMS`). Cameron
deploys it from the laptop to the `git-web` guest on l5400 with
`kata/ngit-grasp/deploy-spa.sh` in the `sovtech/l5400` repository.
