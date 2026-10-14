#!/usr/bin/env bash
# Exercise publication guards and artifact handoff without real credentials.
set -euo pipefail
unset BASH_ENV
scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/checkout"
export REAL_GIT
REAL_GIT=$(command -v git)
export NGIT_CI_INPUTS="$fixture/inputs" NGIT_CI_SECRETS_DIR="$fixture/secrets"
export TEST_MARKER="$fixture/published"
for tool in ngit netlify; do
  cat > "$fixture/bin/$tool" <<'STUB'
#!/usr/bin/env bash
touch "$TEST_MARKER"
exit 91
STUB
  chmod +x "$fixture/bin/$tool"
done
export PATH="$fixture/bin:$PATH"
printf 'APP_VERSION=4.2.1\n' > "$fixture/checkout/version.properties"

run_script() {
  local script=$1
  export NGIT_CI_TRIGGER=$2 NGIT_CI_REF=${3:-} NGIT_CI_REF_TYPE=${4:-}
  export NGIT_CI_REF_NAME=${NGIT_CI_REF#refs/tags/}
  (cd "$fixture/checkout"; bash -euo pipefail -c \
    'source "$1/common.sh"; source "$1/$2.sh"' _ "$scripts" "$script")
}
reject() {
  rm -f "$TEST_MARKER"
  if run_script "$@" > "$fixture/log" 2>&1; then
    echo "Unexpected publication acceptance: $*" >&2
    exit 1
  fi
  test ! -e "$TEST_MARKER"
}
for publisher in netlify nsite; do
  reject "$publisher" pull_request
  reject "$publisher" manual refs/heads/main
  reject "$publisher" push refs/heads/stable
  reject "$publisher" push refs/tags/v4.2.1
done
run_script release manual > "$fixture/log"
grep -q 'publication skipped' "$fixture/log"
test ! -e "$TEST_MARKER"
reject release push refs/tags/v4.2.0 tag
reject release push refs/heads/main branch
reject release pull_request
reject preview push
reject preview manual

# Artifact paths are relative to the prerequisite alias and preserve dotfiles.
mkdir -p "$NGIT_CI_INPUTS/ci.test/artifacts/web-dist"
printf 'tested bytes' > "$NGIT_CI_INPUTS/ci.test/artifacts/web-dist/index.html"
printf 'redirects' > "$NGIT_CI_INPUTS/ci.test/artifacts/web-dist/_redirects"
(cd "$fixture/checkout"; source "$scripts/common.sh"; copy_tested_site)
cmp "$fixture/checkout/dist/index.html" "$NGIT_CI_INPUTS/ci.test/artifacts/web-dist/index.html"
test -f "$fixture/checkout/dist/_redirects"

# Fetch and peel the reviewed tag with real Git, replacing only remote transport.
export GIT_AUTHOR_NAME=Fixture GIT_COMMITTER_NAME=Fixture
export GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_EMAIL=fixture@example.invalid
export TEST_REMOTE="$fixture/source"
mkdir "$TEST_REMOTE"
"$REAL_GIT" -C "$TEST_REMOTE" init -q
"$REAL_GIT" -C "$TEST_REMOTE" commit --allow-empty -qm allocated
export NGIT_CI_COMMIT_SHA
NGIT_CI_COMMIT_SHA=$("$REAL_GIT" -C "$TEST_REMOTE" rev-parse HEAD)
"$REAL_GIT" -C "$fixture/checkout" init -q
"$REAL_GIT" -C "$fixture/checkout" fetch -q "$TEST_REMOTE" "$NGIT_CI_COMMIT_SHA"
"$REAL_GIT" -C "$fixture/checkout" checkout -q --detach FETCH_HEAD
mkdir -p "$NGIT_CI_INPUTS/android-sign/artifacts/signed" "$NGIT_CI_INPUTS/android-sign/outputs"
printf 'signed APK' > "$NGIT_CI_INPUTS/android-sign/artifacts/signed/gitworkshop-android-v4.2.1.apk"
printf '4.2.1\n' > "$NGIT_CI_INPUTS/android-sign/outputs/version"
cat > "$fixture/bin/git" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == fetch ]]; then
  exec "$REAL_GIT" fetch --no-tags --force "$TEST_REMOTE" refs/tags/v4.2.1:refs/tags/v4.2.1
fi
exec "$REAL_GIT" "$@"
STUB
cat > "$fixture/bin/ngit" <<'STUB'
#!/usr/bin/env bash
set -eu
test -f release-artifacts/gitworkshop-android-v4.2.1.apk
printf '%s\n' "$@" > "$TEST_MARKER"
STUB
chmod +x "$fixture/bin/git" "$fixture/bin/ngit"
reject release push refs/tags/v4.2.1 tag # Missing tag.
"$REAL_GIT" -C "$TEST_REMOTE" tag v4.2.1
run_script release push refs/tags/v4.2.1 tag > "$fixture/log" 2>&1
grep -Fxq "$NGIT_CI_COMMIT_SHA" "$TEST_MARKER"
grep -Fxq v4.2.1 "$TEST_MARKER"
test "$("$REAL_GIT" -C "$fixture/checkout" rev-parse 'refs/tags/v4.2.1^{commit}')" = "$NGIT_CI_COMMIT_SHA"
"$REAL_GIT" -C "$TEST_REMOTE" commit --allow-empty -qm moved
"$REAL_GIT" -C "$TEST_REMOTE" tag -f v4.2.1 >/dev/null
reject release push refs/tags/v4.2.1 tag

# A cancellation already recorded must never start publication.
export NGIT_CI_CANCEL_FILE="$fixture/cancelled"
touch "$NGIT_CI_CANCEL_FILE"
rm -f "$TEST_MARKER"
if (source "$scripts/common.sh"; finish_publication touch "$TEST_MARKER"); then
  echo 'Publication started after cancellation' >&2
  exit 1
fi
test ! -e "$TEST_MARKER"
unset NGIT_CI_CANCEL_FILE
mkfifo "$fixture/release"
timeout --kill-after=2 15 bash -euo pipefail -s -- "$scripts" "$fixture" <<'CHECK'
scripts=$1
fixture=$2
coproc publication {
  source "$scripts/common.sh"
  finish_publication bash -euc 'echo ready; read -r _ < "$1/release"; echo finished > "$1/published"' _ "$fixture"
}
pid=$publication_PID
read -r -t 10 -u "${publication[0]}" ready
test "$ready" = ready
kill -TERM "$pid"
printf 'continue\n' > "$fixture/release"
wait "$pid"
grep -Fxq finished "$fixture/published"
CHECK
printf '%s\n' 'Publication guards, tag verification, artifact handoff and graceful completion passed.'
