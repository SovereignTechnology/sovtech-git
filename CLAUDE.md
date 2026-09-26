# SovTech Git — agent rules

This repository is **SovTech Git**, a fork of [GitWorkshop](https://gitworkshop.dev)
by DanConwayDev (MIT). It must keep taking upstream updates cheaply, so almost
every rule here protects mergeability. Read `SOVTECH.md` for the full picture.
The implementation plan lives in Cameron's
`~/.claude/plans/i-want-to-fork-streamed-ritchie.md`.

## Where changes go

- Put SovTech code in new paths only: `src/sovtech/**`, `ci/sovtech/**`,
  `SOVTECH.md`, `NOTICE.md`, `CHANGELOG.sovtech.md`, `.gitlab-ci.yml`.
- Edit an upstream file **only** at a seam listed in
  `ci/sovtech/touched-upstream.txt` (once it exists), within its line budget.
- **Never edit** `CHANGELOG.md`, `AGENTS.md`, `src/AppRouter.tsx`,
  `src/pages/repo/*`, `src/pages/PRPage.tsx`, `src/pages/Settings.tsx`,
  `src/pages/Dashboard.tsx`, `src/services/nostr.ts` or `src/lib/nip34.ts`.
  They change almost every week upstream.
- **Never rename functional identifiers**: the NIP-78 d-tags
  (`gitworkshop-repo-selections-v1`, `git-notifications-state`,
  `git-notifications-nsec`), the IndexedDB names, the `gitworkshop:*`
  localStorage keys, `gitworkshop-reload`, `gitworkshop/namecoin-nip05`,
  `BUZZ_SOFTWARE_URL`, or the Android namespace. Renaming breaks interop and
  orphans users' data.
- Paths in `ci/sovtech/fork-deleted.txt` stay deleted; the sync script
  re-deletes them.

## Upstream's AGENTS.md

`AGENTS.md` is upstream's file. Use it as a **code-style and architecture
reference only**. Its release, CHANGELOG, MCP, auto-commit and pre-commit
instructions do not apply here. Where it conflicts with this file, this file
wins.

## Building and testing

- **Never run `pnpm install`, `pnpm test`, `pnpm dev` or any upstream script
  on the laptop.** Dependency install scripts and upstream code run only in the
  fresh-VM GitLab CI runners. Preview CI-built `dist` artifacts with a static
  server instead.
- Laptop tooling that is not upstream code is fine: `git`, `gitleaks`,
  `shellcheck`, `node --check`, Python scripts under `ci/sovtech/`.

## Identity and history

- Commit as `sovITxyz <git@sovit.xyz>` (set locally). Merge commits pushed to
  GitHub or ngit are `sovtech <git@sovit.xyz>`: use
  `git -c user.name=sovtech -c user.email=git@sovit.xyz merge …`, then check
  `git log -1 --format='%an <%ae>'`.
- **No AI attribution** in commits, MR text or files.
- Upstream commits are Dan's history: never rewrite them.
- Run `git status` immediately before every commit.

## GitLab merge rules (`sovtech/git`)

- `main` is push-protected; every change is an MR. The project is
  fast-forward only with squash disabled, so squash feature branches locally
  before pushing.
- Merge only through the API, pinned to the SHA the gate passed:
  `glab api -X PUT projects/88/merge_requests/<iid>/merge -f sha=<sha>`.
- **Never use** the web UI's Merge, Rebase, Apply suggestion, Web IDE, Revert
  or Cherry-pick buttons: they create commits authored by the GitLab user.
- **Upstream-sync MRs are merge commits: never squash them, never rebase
  them.** If `main` moved, regenerate the sync branch.

## Nostr and publishing

- Never push to the `upstream` remote (Dan's repository).
- Never run `ngit init` from this checkout: it rewrites `origin` and signs
  every ref it sees. Announcements run from a throwaway clone with no `origin`.
- Only `main` and `sovtech-v*` tags go to the `nostr` remote.
- Never list git config without `--name-only`.
