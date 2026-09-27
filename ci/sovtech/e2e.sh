#!/usr/bin/env bash
# Upstream's e2e suites against a real ngit-grasp 3.0.0 (the version upstream's
# flake pins), built from crates.io with its lockfile. The suites skip
# themselves when no binary is found, so a skip is a failure here: the JUnit
# report must exist, be non-empty, hold at least one testcase and contain no
# <skipped. Run after `pnpm install --frozen-lockfile`.
#
# Usage: ci/sovtech/e2e.sh JUNIT_FILE
set -euo pipefail

readonly GRASP_VERSION=3.0.0
# Upstream's flake builds the crate with this revision string; mirror it.
readonly GRASP_BUILD_REVISION=bce30ef039ecbc8c2371008e1bd00eedd79bbccf
export PYTHONDONTWRITEBYTECODE=1

HERE=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
readonly HERE

die() {
  printf 'ERROR e2e: %s\n' "$*" >&2
  exit 4
}

report=${1:?usage: e2e.sh JUNIT_FILE}
command -v cargo >/dev/null || die 'cargo is required to build ngit-grasp'

root="$HOME/.local/ngit-grasp-$GRASP_VERSION"
NGIT_BUILD_REVISION=$GRASP_BUILD_REVISION \
  cargo install ngit-grasp --locked --version "$GRASP_VERSION" --root "$root"
listing=$(cargo install --list --root "$root")
[[ $listing == *"ngit-grasp v$GRASP_VERSION:"* ]] || die "ngit-grasp $GRASP_VERSION is not what cargo installed"
bin="$root/bin/ngit-grasp"
[[ -f $bin && -x $bin && ! -L $bin ]] || die 'ngit-grasp binary missing'
export NGIT_GRASP_BIN=$bin

mkdir -p -- "$(dirname -- "$report")"
rm -f -- "$report"
rc=0
pnpm exec vitest run --config vitest.e2e.config.ts \
  --reporter=default --reporter=junit --outputFile.junit="$report" || rc=$?

check=0
python3 -I "$HERE/ci_tools.py" junit-check --file "$report" || check=$?
case $check in
  0) ;;
  3) die 'the JUnit report shows skipped, failed or no tests' ;;
  *) die 'the JUnit report could not be checked' ;;
esac
((rc == 0)) || die "vitest e2e exited $rc"
echo 'e2e: every suite ran against ngit-grasp and passed'
