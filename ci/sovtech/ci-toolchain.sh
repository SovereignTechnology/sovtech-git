#!/usr/bin/env bash
# Assert the CI toolchain before any dependency is installed: Node major 24
# and one exact pnpm version through corepack. The version is upstream's
# packageManager pin, and it must be one of PNPM_ALLOWED: a new upstream pnpm
# fails closed here until a reviewed change adds it. Two versions are allowed
# while a sync moves the fork from one to the next, because main and the sync
# branch are tested by the same gate. Installs a pnpm shim in
# $HOME/.local/bin, which the job puts first on PATH, and records the
# versions for build-info.json.
#
# Usage: ci/sovtech/ci-toolchain.sh RECORD_FILE
set -euo pipefail

readonly PNPM_ALLOWED=(9.15.9 10.34.9) NODE_MAJOR=24
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

die() {
  printf 'ERROR toolchain: %s\n' "$*" >&2
  exit 4
}

record=${1:?usage: ci-toolchain.sh RECORD_FILE}

node_version=$(node --version)
[[ $node_version =~ ^v${NODE_MAJOR}\.[0-9]+\.[0-9]+$ ]] ||
  die "node must be major $NODE_MAJOR, found $node_version"

pinned=$(python3 -I -c 'import json; print(json.load(open("package.json"))["packageManager"])')
[[ $pinned =~ ^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
  die "package.json packageManager is not pnpm@<exact version> (found: $pinned)"
allowed=0
for candidate in "${PNPM_ALLOWED[@]}"; do
  [[ $candidate == "${BASH_REMATCH[1]}" ]] && allowed=1
done
((allowed)) || die "package.json packageManager $pinned is not one of: ${PNPM_ALLOWED[*]}"
readonly PNPM_VERSION=${BASH_REMATCH[1]}

corepack_version=$(corepack "pnpm@$PNPM_VERSION" --version)
[[ $corepack_version == "$PNPM_VERSION" ]] || die "corepack pnpm@$PNPM_VERSION reported another version"

mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin" pnpm
shim=$(command -v pnpm) || die 'no pnpm on PATH after corepack enable'
[[ $shim == "$HOME/.local/bin/pnpm" ]] || die 'the corepack pnpm shim is not first on PATH'
pnpm_version=$(pnpm --version)
[[ $pnpm_version == "$PNPM_VERSION" ]] || die "pnpm on PATH is not $PNPM_VERSION"

mkdir -p -- "$(dirname -- "$record")"
printf 'node=%s\npnpm=%s\n' "$node_version" "$pnpm_version" >"$record"
printf 'toolchain: node %s, pnpm %s (corepack)\n' "$node_version" "$pnpm_version"
