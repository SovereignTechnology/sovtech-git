# SovTech Git changelog

Changes made by the fork. Upstream's changes are in `CHANGELOG.md`, which the
fork never edits.

## Unreleased

- Fork created from upstream `420c0c3d` (v4.1.0 plus 31 commits).
- Removed upstream's agent and MCP configuration, its Netlify, nsite and
  Zapstore publishing identity, its Nostr CI workflows and its Android App
  Links file (see `ci/sovtech/fork-deleted.txt`).
- Added the fork's rules (`CLAUDE.md`, `SOVTECH.md`), `NOTICE.md` and a
  disabled Renovate config.
- Added the GitLab CI pipeline (`.gitlab-ci.yml`) and the gate
  (`ci/sovtech/gate.sh`): fork identity and trailer checks, pinned gitleaks,
  the overlay guard, the brand-leak ratchet and a dist secret scan. The
  ratchet's `pending` list is seeded from the first CI run.
- Added `ci/sovtech/sync-upstream.sh` and the weekly drift report.
- Hardened the gate and the sync against upstream code: upstream changes to
  fork-owned paths are refused, the sync runs its rules from the fork head
  only, and every Python check runs isolated (`python3 -I`). `--finish`
  re-validates the merge, and fork-deleted entries are literal paths. Reports
  escape non-printable characters.
- Runner routing now comes from ref protection alone (`SOVGIT_RUNNER_TAG`),
  enforced by `ci/sovtech/ci_config.py`. gitleaks scans merge resolutions,
  release and target-less CI runs prove `UPSTREAM_BASE` on upstream `main`,
  gate changes are listed for review, and the dist checks are re-run where no
  dependency code ran (the `recheck` jobs and the package jobs).
- Sync branches may update the gate's data files but never its code or the
  CI config. gitleaks reads files marked `-diff` as text, octopus merges are
  refused, the dist scans fail on any symlink, and every Python check
  refuses to run without `-I` before importing anything.
- gitleaks runs with `ci/sovtech/gitleaks.toml` (8.30.1's default without
  the image, font, document and `node_modules` allowlists). The scripts
  compile `sovci.py` from source, so no `.pyc` is ever read, and bytecode
  under `ci/sovtech` is refused. `parallel` is refused in the CI config, the
  drift schedule carries no variables, and `SOVTECH.md` records the
  protected-runner token rotation policy.
- Theme and brand assets: the www.sovtech.pro palette (orange `#F7931A` on
  `#0A0A0A`) in `src/sovtech/theme.css`, with upstream's pink accent on a
  theme-aware brand scale, amber on yellow and the pink label bucket on
  fuchsia; Inter for text and mono headings; dark by default, with light and
  system kept. The chevron-B mark (`src/sovtech/brand/`) replaces upstream's
  favicons and app icons and adds the NIP-11 `public/icon.png`, all generated
  by `ci/sovtech/gen-brand-assets.py`. `nostr.json` names only SovTech, and
  `public/LICENSE.txt` carries the MIT notice.
