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
- Added the overlay engine (`src/sovtech/vite-plugin.ts`, first in
  `vite.config.ts`'s plugins): the "SovTech Git" app name, hidden source maps,
  module shadowing from `ci/sovtech/shadow-map.tsv`, build-time rewrites of
  upstream brand copy (every rule must match in `vite build`), a re-branded
  `index.html` with `og:url` on `https://git.sovtech.pro/` and the CSP meta
  untouched, and the SovTech web manifest (also swapped in `public/`). Page
  titles end in "SovTech Git" through an unhead plugin (`src/sovtech/head.ts`),
  and a test fails when an upstream title no longer matches its rewrite. A
  build whose audit passed prints one line and marks its entry chunk with the
  `sovtech-overlay:audited` sentinel.
- Theme and brand assets: the www.sovtech.pro palette (orange `#F7931A` on
  `#0A0A0A`) in `src/sovtech/theme.css`, with upstream's pink accent on a
  theme-aware brand scale, amber on yellow and the pink label bucket on
  fuchsia; Inter for text and mono headings; dark by default, with light and
  system kept. The chevron-B mark (`src/sovtech/brand/`) replaces upstream's
  favicons and app icons and adds the NIP-11 `public/icon.png`, all generated
  by `ci/sovtech/gen-brand-assets.py`. `nostr.json` names only SovTech, and
  `public/LICENSE.txt` carries the MIT notice. The gate records upstream's
  palette digest (`ci/sovtech/upstream-palette.sha256`), checks that
  theme.css is the last palette in the built CSS and that no lazy chunk,
  inline style or script sets a palette variable, and checks the committed
  brand assets without Chromium (`gen-brand-assets.py --check`).
- SovTech defaults (`src/sovtech/defaults.ts`): fallback relays and GRASP
  servers now lead with git.sovit.xyz and git.buildinelsalvador.com, nos.lol
  is gone from every default list (relay.nos.social for NIP-46,
  relay.primal.net for new accounts), and links to git.sovtech.pro and
  git.sovit.xyz are recognised next to upstream's host. The git index,
  lookup relays, Blossom servers and CORS proxy keep upstream's values.
- The SovTech shell (`src/sovtech/overlays/`, spec in `SOVTECH.md`): a new
  header, footer, landing page, About, 404 and OG image page, swapped in
  through six `shadow-map.tsv` rows with tsc-checked export shapes
  (`src/sovtech/contract.ts`) and a header and footer parity test. The
  landing page leads with repositories from the SovTech key, then the live
  network strip; About credits upstream and takes feedback on SovTech Git's
  own repository. The upstream-fork input hint names git.sovtech.pro, fork
  code gets a `brand` colour alias, theme.css honours reduced motion, and
  the brand ratchet's `pending` list is empty.
