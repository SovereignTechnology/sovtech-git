#!/usr/bin/env bash
# SovTech Git gate. Runs in CI on fresh VMs; safe to run on the laptop too,
# because it executes no upstream or dependency code (git, gitleaks, Python).
# Every Python check runs as python3 -I (isolated: neither the script's
# directory nor the working directory is on sys.path, and PYTHON* variables
# are ignored), so no file in the tree can stand in for a stdlib module.
#
# Usage: ci/sovtech/gate.sh [--release | --baseline]
#                           [--phase all|history|dist|recheck]
#                           [--dist DIR] [--maps DIR] [--target REV]
#
#   default     MR and main pipelines.
#   --release   also requires brand-allowlist.json "pending" to be empty and
#               shadow-map.tsv to hold exactly 6 rows (tags, the mirror, the
#               ngit announcement), and proves UPSTREAM_BASE on upstream main.
#   --baseline  report-only: move the maps out and print the brand-term counts
#               that seed "pending". Exits 0 unless the scan cannot run.
#   --phase     history = git-only checks (run before any dependency is
#               installed); dist = checks on the built dist; all = both;
#               recheck = the dist checks again on a dist whose maps were
#               already moved out, in a job that never ran dependency code.
#
# The fork commit set is FORK = git rev-list TARGET..HEAD --not UPSTREAM_BASE.
# TARGET, in order:
#   1. --target REV;
#   2. CI_MERGE_REQUEST_DIFF_BASE_SHA (merge request pipelines);
#   3. nothing on tag pipelines: the whole fork set since UPSTREAM_BASE;
#   4. CI_COMMIT_BEFORE_SHA on branch pipelines, when it is a real commit and
#      an ancestor of HEAD (main pipelines check what the merge added);
#   5. in CI otherwise (first push, schedules): the whole fork set;
#   6. locally: origin/main when it is an ancestor of HEAD, else the whole set.
# The push range (hs.internal check, gitleaks) is TARGET..HEAD, or
# HEAD --not UPSTREAM_BASE when there is no TARGET.
#
# Every scan fails closed: a check that cannot run is a failure, every grep
# return code is read explicitly (1 = no match, anything above 1 = error),
# and the gitleaks, brand, secret, fork-owned, bytecode and CI-config checks
# each prove they fire on a planted sample before they are trusted. Output is
# ids, paths and counts only.
set -euo pipefail

SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
HERE=$(dirname -- "$SELF")
readonly SELF HERE

readonly FORK_ID='sovITxyz <git@sovit.xyz>'
readonly MERGE_ID='sovtech <git@sovit.xyz>'
readonly UPSTREAM_ROOT=19dd6a8781c9b3a37d21f4655c94b08791b9d0f4
readonly GITLEAKS_VERSION=8.30.1
readonly GITLEAKS_NAME="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
readonly GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_NAME}"
readonly DAN_NPUB=npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr
readonly GRASP_URLS=(
  "https://gitnostr.com/$DAN_NPUB/gitworkshop.git"
  "https://relay.ngit.dev/$DAN_NPUB/gitworkshop.git"
)
# The gate's own code and the CI config: every change to them is listed for
# review. A sync branch may change only the data files a sync legitimately
# updates (an allow-list of exact paths, each a regular file); any change to
# the gate's code (*.sh, *.py, tools.sha256, gitleaks.toml, .gitleaksignore,
# fork-deleted.txt, anything new) or to .gitlab-ci.yml fails there.
readonly GATE_PATHS=(ci/sovtech .gitlab-ci.yml)
readonly SYNC_MAY_CHANGE=(
  ci/sovtech/UPSTREAM_BASE
  ci/sovtech/shadow-map.tsv
  ci/sovtech/brand-allowlist.json
  ci/sovtech/touched-upstream.txt
  ci/sovtech/asset-swaps.tsv
  ci/sovtech/agent-config-allow.txt
  ci/sovtech/upstream-palette.sha256
)
# The git log options of every gitleaks history scan. --diff-merges=remerge
# reads a merge as its remerge diff: what the resolution changed against
# git's own automatic merge (git >= 2.36). --text shows files that
# .gitattributes marks -diff (upstream has '*.ts -diff'), which git log would
# otherwise print as "Binary files differ", unscanned. --no-textconv keeps a
# configured textconv filter from rewriting what the scanner sees.
readonly SCAN_LOG_OPTS='--text --no-textconv --diff-merges=remerge'
export PYTHONDONTWRITEBYTECODE=1

die() {
  printf 'ERROR gate: %s\n' "$*" >&2
  exit 4
}

# grep_rc PATTERN-FLAGS... -- reads $GREP_INPUT; prints nothing.
# Returns 0 on a match, 1 on no match, and dies on any other code.
grep_rc() {
  local rc=0
  grep -q "$@" <<<"$GREP_INPUT" || rc=$?
  case $rc in
    0 | 1) return "$rc" ;;
    *) die "grep exited $rc" ;;
  esac
}

# py_rc NAME CMD... : 0 = clean, 3 = findings, anything else = error.
py_rc() {
  local name=$1 rc=0
  shift
  "$@" || rc=$?
  case $rc in
    0) return 0 ;;
    3)
      printf 'FAIL %s: findings above\n' "$name"
      return 3
      ;;
    *)
      printf 'ERROR %s: the check could not run (exit %d)\n' "$name" "$rc"
      return 4
      ;;
  esac
}

is_commit() {
  [[ $1 =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$1^{commit}" 2>/dev/null
}

# is_ancestor A B: 0 when A is an ancestor of (or equal to) B, 1 when not;
# dies on any other merge-base exit code instead of reading it as "no".
is_ancestor() {
  local rc=0
  git merge-base --is-ancestor "$1" "$2" || rc=$?
  case $rc in
    0 | 1) return "$rc" ;;
    *) die "git merge-base exited $rc" ;;
  esac
}

# The branch whose changes are being gated, when there is one: the MR source
# branch in merge request pipelines; locally the current branch unless it is
# main or HEAD is detached; empty for main and tag pipelines.
source_branch() {
  local branch=""
  if [[ -n ${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME:-} ]]; then
    branch=$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME
  elif [[ -z ${CI:-} ]]; then
    branch=$(git symbolic-ref --quiet --short HEAD || true)
    [[ $branch != main ]] || branch=""
  fi
  printf '%s' "$branch"
}

# Private refs a step fetched into; removed when that step's process exits.
gate_refs=()
drop_gate_refs() {
  local ref
  for ref in "${gate_refs[@]}"; do git update-ref -d "$ref" 2>/dev/null || true; done
}

# ---------------------------------------------------------------- steps ---

step_identity() {
  local -a fork_args push_args
  if [[ -n $GATE_TARGET ]]; then
    fork_args=("$GATE_TARGET..HEAD" --not "$GATE_BASE")
    push_args=("$GATE_TARGET..HEAD")
  else
    fork_args=(HEAD --not "$GATE_BASE")
    push_args=(HEAD --not "$GATE_BASE")
  fi
  local list fails=0 n=0 sha parents an cn np trailers body
  list=$(git -c log.showSignature=false log --no-color \
    --format='%H%x1f%P%x1f%an <%ae>%x1f%cn <%ce>' "${fork_args[@]}")
  while IFS=$'\x1f' read -r sha parents an cn; do
    [[ -n $sha ]] || continue
    n=$((n + 1))
    read -r -a np <<<"$parents"
    # gitleaks scans a merge as its remerge diff, which git produces for two
    # parents only: an octopus merge's resolution would go unscanned.
    if ((${#np[@]} > 2)); then
      printf 'FAIL identity: commit %s has %d parents; octopus merges are refused\n' \
        "${sha:0:12}" "${#np[@]}"
      fails=$((fails + 1))
    fi
    if ((${#np[@]} >= 2)); then
      if [[ $an != "$FORK_ID" && $an != "$MERGE_ID" ]] ||
        [[ $cn != "$FORK_ID" && $cn != "$MERGE_ID" ]]; then
        printf 'FAIL identity: merge %s is not %s or %s\n' "${sha:0:12}" "$FORK_ID" "$MERGE_ID"
        fails=$((fails + 1))
      fi
    elif [[ $an != "$FORK_ID" || $cn != "$FORK_ID" ]]; then
      printf 'FAIL identity: commit %s author/committer is not %s\n' "${sha:0:12}" "$FORK_ID"
      fails=$((fails + 1))
    fi
    trailers=$(git log -1 --no-walk --format='%(trailers:only,unfold)' "$sha")
    if [[ -n ${trailers//[[:space:]]/} ]]; then
      printf 'FAIL trailers: commit %s carries trailer(s): %s\n' "${sha:0:12}" \
        "$(sed -n 's/^\([A-Za-z0-9-]*\):.*/\1/p' <<<"$trailers" | sort -u | tr '\n' ' ')"
      fails=$((fails + 1))
    fi
    body=$(git log -1 --no-walk --format='%B' "$sha")
    GREP_INPUT=$body
    if grep_rc -iF 'generated with'; then
      printf "FAIL attribution: commit %s mentions 'Generated with'\n" "${sha:0:12}"
      fails=$((fails + 1))
    fi
    if grep_rc -iE '^[[:space:]]*co-authored-by[[:space:]]*:'; then
      printf 'FAIL attribution: commit %s has a Co-Authored-By line\n' "${sha:0:12}"
      fails=$((fails + 1))
    fi
  done <<<"$list"
  printf 'identity: %d fork commit(s) checked\n' "$n"

  local ids
  ids=$(git log --no-color --format='%an%n%ae%n%cn%n%ce' "${push_args[@]}")
  GREP_INPUT=$ids
  if grep_rc -iF 'hs.internal'; then
    echo 'FAIL identity: an author or committer in the push range contains hs.internal'
    fails=$((fails + 1))
  fi
  ((fails == 0)) || return 3
  echo 'ok   identity: fork identity, at most two parents, no trailers, no attribution, no hs.internal'
}

step_fork_owned_base() {
  # No upstream commit may add, change or delete a fork-owned path. Upstream
  # has none at UPSTREAM_BASE, so a sync merge can never touch one; a base
  # that holds one is upstream reaching into the gate, or a fork commit
  # passed off as the base.
  py_rc fork-owned-base python3 -I "$HERE/overlay_guard.py" base-tree --base "$GATE_BASE"
}

# Prove GATE_BASE is on upstream main as both GRASP servers publish it.
# Otherwise a branch could claim any commit as the base, and every commit
# reachable from it would drop out of the identity checks and the numstat
# bound. https only, no credential helper (no CI token can reach a GRASP
# server); any fetch failure is a failure.
grasp_proof() {
  trap drop_gate_refs EXIT
  local i=0 url ref got
  for url in "${GRASP_URLS[@]}"; do
    ref="refs/sovtech-gate/$$/grasp-$i"
    gate_refs+=("$ref")
    if ! GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c protocol.allow=never \
      -c protocol.https.allow=always -c http.lowSpeedLimit=1 -c http.lowSpeedTime=60 \
      fetch --quiet --no-tags --no-write-fetch-head "$url" "+refs/heads/main:$ref"; then
      printf 'FAIL upstream-base: could not fetch upstream main from GRASP server %d\n' "$i"
      return 3
    fi
    if ! got=$(git rev-parse --verify --quiet "$ref^{commit}"); then
      printf 'FAIL upstream-base: GRASP server %d sent no main commit\n' "$i"
      return 3
    fi
    # Control: HEAD carries fork commits, so it is never on upstream main.
    # If it is, the fetch did not reach upstream and the check proves nothing.
    if is_ancestor HEAD "$got"; then
      printf 'FAIL upstream-base: control: HEAD is on the main of GRASP server %d\n' "$i"
      return 3
    fi
    if ! is_ancestor "$GATE_BASE" "$got"; then
      printf 'FAIL upstream-base: UPSTREAM_BASE is not on upstream main at GRASP server %d\n' "$i"
      return 3
    fi
    printf 'upstream-base: UPSTREAM_BASE is on upstream main %s at GRASP server %d\n' "${got:0:12}" "$i"
    i=$((i + 1))
  done
}

step_upstream_base() {
  # BASE must be a direct parent of at least one fork commit: the upstream
  # commit the fork branched from, or the second parent of the latest sync
  # merge. Anything else (a bump without a merge, an older or unrelated
  # commit) fails. A change against TARGET is allowed only on sync branches.
  # The GRASP proof runs whenever TARGET does not already vouch for the base:
  # a changed or newly added base, release mode, and CI runs without TARGET.
  local fork_args=(HEAD --not "$GATE_BASE") parents list
  [[ -z $GATE_TARGET ]] || fork_args=("$GATE_TARGET..HEAD" --not "$GATE_BASE")
  list=$(git log --no-color --format='%P' HEAD --not "$GATE_BASE")
  GREP_INPUT=$list
  if ! grep_rc -wF "$GATE_BASE"; then
    echo 'FAIL upstream-base: UPSTREAM_BASE is not a parent of any fork commit'
    return 3
  fi

  # The base TARGET recorded. ls-tree separates "absent" (exit 0, no output)
  # from a real error (non-zero, which dies); git cat-file -e exits 128 for
  # both, so it cannot.
  local old="" entry why=""
  if [[ -n $GATE_TARGET ]]; then
    entry=$(git ls-tree --full-tree "$GATE_TARGET" -- ci/sovtech/UPSTREAM_BASE) ||
      die 'cannot list ci/sovtech/UPSTREAM_BASE at TARGET'
    if [[ -n $entry ]]; then
      [[ $entry =~ ^100(644|755)\ blob\  ]] ||
        { echo 'FAIL upstream-base: UPSTREAM_BASE at TARGET is not a regular file'; return 3; }
      old=$(git cat-file blob "$GATE_TARGET:ci/sovtech/UPSTREAM_BASE") ||
        die 'cannot read ci/sovtech/UPSTREAM_BASE at TARGET'
      is_commit "$old" || { echo 'FAIL upstream-base: UPSTREAM_BASE at TARGET is not a commit'; return 3; }
    else
      why="UPSTREAM_BASE is new against TARGET"
    fi
  fi

  if [[ -n $old && $old != "$GATE_BASE" ]]; then
    if ! is_ancestor "$old" "$GATE_BASE"; then
      echo 'FAIL upstream-base: the new base does not descend from the old one'
      return 3
    fi
    parents=$(git log --no-color --format='%P' "${fork_args[@]}")
    GREP_INPUT=$parents
    if ! grep_rc -E "^[0-9a-f]{40} ${GATE_BASE}( |\$)"; then
      echo 'FAIL upstream-base: no merge in this range has the new base as parent 2'
      return 3
    fi
    # MR pipelines must come from a sync branch. Main pipelines rely on the
    # parent-2 proof above (the MR was checked before it merged).
    local branch
    branch=$(source_branch)
    if [[ -n $branch && $branch != sync/upstream-* ]]; then
      echo 'FAIL upstream-base: only sync/upstream-* branches may change UPSTREAM_BASE'
      return 3
    fi
    why="changed by a sync merge"
  elif [[ $GATE_MODE == release ]]; then
    why="release mode"
  elif [[ -z $GATE_TARGET && -n ${CI:-} ]]; then
    why="no TARGET in CI"
  fi

  if [[ -z $why && -n $GATE_TARGET ]]; then
    echo 'ok   upstream-base: unchanged against TARGET'
    return 0
  elif [[ -z $why ]]; then
    echo 'ok   upstream-base: no TARGET outside CI and not a release: not re-proven here'
    return 0
  fi
  local rc=0
  grasp_proof || rc=$?
  ((rc == 0)) || return "$rc"
  printf 'ok   upstream-base: %s; on upstream main at both GRASP servers\n' "$why"
}

step_gate_change() {
  # The gate checks the change that may rewrite the gate. Every changed path
  # of its code and the CI config is listed for a person; a sync branch, whose
  # review is of upstream's changes, may change only SYNC_MAY_CHANGE data
  # files, and each must stay a regular file.
  local branch
  branch=$(source_branch)
  if [[ -z $GATE_TARGET ]]; then
    if [[ $branch == sync/upstream-* ]]; then
      echo 'FAIL gate-change: no TARGET on a sync branch, so its gate changes cannot be listed'
      return 3
    fi
    echo 'info gate-change: no TARGET; the gate is what main already carries'
    return 0
  fi
  local list path n=0 fails=0 data entry
  list=$(git -c core.quotePath=true diff --no-ext-diff --no-textconv --no-renames \
    --name-only "$GATE_TARGET" HEAD -- "${GATE_PATHS[@]}") || die 'git diff of the gate paths failed'
  while IFS= read -r path; do
    [[ -n $path ]] || continue
    n=$((n + 1))
    printf 'REVIEW gate-change: %s\n' "$path"
    [[ $branch == sync/upstream-* ]] || continue
    data=0
    for entry in "${SYNC_MAY_CHANGE[@]}"; do
      [[ $path != "$entry" ]] || data=1
    done
    if ((!data)); then
      printf 'FAIL gate-change: sync branch %s changes gate code or CI config: %s\n' "${branch:0:40}" "$path"
      fails=$((fails + 1))
      continue
    fi
    # core.quotePath above leaves an allow-listed path unquoted, so it is the
    # literal path here.
    entry=$(git ls-tree --full-tree HEAD -- "$path") || die "cannot list $path at HEAD"
    if [[ ! $entry =~ ^100644\ blob\  ]]; then
      printf 'FAIL gate-change: sync branch %s leaves %s missing or not a regular file\n' "${branch:0:40}" "$path"
      fails=$((fails + 1))
    fi
  done <<<"$list"
  ((fails == 0)) || return 3
  printf 'ok   gate-change: %d gate path(s) changed against TARGET\n' "$n"
}

# Bytecode is never gate code. Every script compiles sovci.py from its source
# and reads no .pyc, but a __pycache__ entry or .pyc file committed under
# ci/sovtech could still be picked up by any other way of running the code,
# so HEAD's tree may hold none. Case-insensitive, for case-insensitive
# checkouts.
is_bytecode_path() {
  local p=${1,,} re='(^|/)__pycache__(/|$)'
  [[ $p =~ $re || $p == *.pyc ]]
}

step_gate_bytecode() {
  local tmp path n=0 fails=0 seen=0 ctl
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # expand now: tmp is local
  trap "rm -rf -- '$tmp'" EXIT
  # Positive control: the matcher flags every planted shape and passes the
  # gate's own sources.
  for ctl in ci/sovtech/__pycache__/sovci.cpython-312.pyc ci/sovtech/__pycache__ \
    ci/sovtech/sub/x.pyc ci/sovtech/__PYCACHE__/x.bin ci/sovtech/X.PYC; do
    is_bytecode_path "$ctl" || die "bytecode control: $ctl was not flagged"
  done
  for ctl in ci/sovtech/sovci.py ci/sovtech/gate.sh ci/sovtech/pycache.txt; do
    ! is_bytecode_path "$ctl" || die "bytecode control: $ctl was flagged"
  done
  # -t lists tree entries too, so a __pycache__ directory, symlink or
  # submodule shows up itself; -z keeps every name literal.
  git ls-tree -r -t -z --name-only --full-tree HEAD -- ci/sovtech >"$tmp/list" ||
    die 'cannot list ci/sovtech at HEAD'
  while IFS= read -r -d '' path; do
    [[ $path != ci/sovtech/* ]] || n=$((n + 1))
    [[ $path != ci/sovtech/gate.sh ]] || seen=1
    if is_bytecode_path "$path"; then
      printf 'FAIL gate-bytecode: %q is bytecode under ci/sovtech\n' "$path"
      fails=$((fails + 1))
    fi
  done <"$tmp/list"
  ((seen)) || die 'bytecode control: the HEAD listing does not show ci/sovtech/gate.sh'
  ((fails == 0)) || return 3
  printf 'ok   gate-bytecode: %d entries under ci/sovtech at HEAD, no __pycache__ or .pyc\n' "$n"
}

step_ci_config() {
  local tmp
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # expand now: tmp is local
  trap "rm -rf -- '$tmp'" EXIT
  git cat-file blob HEAD:.gitlab-ci.yml >"$tmp/gitlab-ci.yml" || die '.gitlab-ci.yml missing at HEAD'
  py_rc ci-config python3 -I "$HERE/ci_config.py" --file "$tmp/gitlab-ci.yml"
}

step_gitleaks() {
  local tmp rc sum root_files
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # expand now: tmp is local
  trap "rm -rf -- '$tmp'" EXIT

  root_files=$(git ls-tree --name-only HEAD)
  GREP_INPUT=$root_files
  if grep_rc -xE '\.gitleaks\.toml|\.gitleaksignore'; then
    echo 'FAIL gitleaks: a repo-root gitleaks config or ignore file would weaken the scan'
    return 3
  fi

  sum=$(awk -v n="$GITLEAKS_NAME" '$2 == n && length($1) == 64 && $1 ~ /^[0-9a-f]+$/ {print $1; c++}
    END {exit c == 1 ? 0 : 1}' "$HERE/tools.sha256") || die "no single pin for $GITLEAKS_NAME in tools.sha256"
  printf '%s  %s\n' "$sum" "$GITLEAKS_NAME" >"$tmp/SHA256SUMS"
  if [[ -n ${GITLEAKS_TARBALL:-} ]]; then
    cp -- "$GITLEAKS_TARBALL" "$tmp/$GITLEAKS_NAME"
  else
    curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --max-time 300 \
      -o "$tmp/$GITLEAKS_NAME" "$GITLEAKS_URL"
  fi
  (cd "$tmp" && sha256sum --check --strict --quiet SHA256SUMS) ||
    die "gitleaks tarball failed its sha256 pin"
  mkdir "$tmp/bin"
  tar -xzf "$tmp/$GITLEAKS_NAME" -C "$tmp/bin" --no-same-owner --no-same-permissions gitleaks
  [[ -f $tmp/bin/gitleaks && ! -L $tmp/bin/gitleaks ]] || die 'gitleaks binary missing from tarball'
  chmod 0755 "$tmp/bin/gitleaks"
  local version
  version=$("$tmp/bin/gitleaks" version)
  [[ ${version#v} == "$GITLEAKS_VERSION" ]] || die "unexpected gitleaks version"
  # The fork's config (gitleaks 8.30.1's default without the image, font,
  # document and node_modules path allowlists), passed with --config to the
  # range scan and every control.
  local config="$HERE/gitleaks.toml"
  [[ -f $config && ! -L $config ]] || die 'ci/sovtech/gitleaks.toml missing or not a regular file'

  # A random, meaningless token of GitHub PAT shape per call.
  plant() { # FILE FORMAT: FORMAT holds one %s for each token (1 or 2)
    python3 -I -c 'import secrets, string, sys
a = string.ascii_letters + string.digits
tok = lambda: "gh" + "p_" + "".join(secrets.choice(a) for _ in range(36))
allow = "gitleaks" + ":allow"
fmt = sys.argv[2].replace("ALLOW", allow)
open(sys.argv[1], "w").write(fmt % tuple(tok() for _ in range(fmt.count("%s"))))' "$1" "$2"
  }

  # Positive control 1: two planted tokens, the second on a line with an
  # inline "gitleaks:allow". Exactly 2 findings prove the scanner fires and
  # that --ignore-gitleaks-allow is in effect: only ci/sovtech/.gitleaksignore
  # may accept a finding.
  mkdir -m 0700 "$tmp/control"
  plant "$tmp/control/planted.txt" $'token = "%s"\nother = "%s" # ALLOW\n'
  rc=0
  (cd "$tmp/control" && env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML \
    "$tmp/bin/gitleaks" dir --no-banner --redact=100 --exit-code 3 --log-level error \
    --ignore-gitleaks-allow --config "$config" \
    --report-format json --report-path "$tmp/control.json" .) >/dev/null 2>&1 || rc=$?
  py_rc gitleaks-control python3 -I "$HERE/ci_tools.py" gitleaks-report \
    --report "$tmp/control.json" --rc "$rc" --expect-count 2 --label 'info control' ||
    die 'gitleaks positive control failed'

  # Nothing inherited may point the control repositories' git commands at
  # the real repository (a hook, for one, exports GIT_DIR).
  local -a own=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_COMMON_DIR -u GIT_NAMESPACE)
  local -a cfg=(-c user.name=gate-control -c user.email=control@invalid
    -c commit.gpgsign=false -c core.hooksPath=/dev/null -c rerere.enabled=false)

  # Positive control 2: a repository whose .gitattributes says '* -diff'
  # (upstream's '*.ts -diff', widened), then a commit planting a token in a
  # file it had already. git log prints that change as "Binary files
  # differ" unless --text is in effect, so exactly one finding, from the
  # planting commit, proves the attribute cannot blind the scan.
  local ac="$tmp/attr-control" abase attr_sha
  local -a ag=("${own[@]}" git -C "$ac" "${cfg[@]}")
  "${own[@]}" git init -q -b trunk "$ac"
  printf '* -diff\n' >"$ac/.gitattributes"
  printf 'value = base\n' >"$ac/f.ts"
  "${ag[@]}" add .gitattributes f.ts
  "${ag[@]}" commit -q -m base
  abase=$("${ag[@]}" rev-parse HEAD)
  plant "$ac/f.ts" $'value = "%s"\n'
  "${ag[@]}" commit -q -am plant
  attr_sha=$("${ag[@]}" rev-parse HEAD)
  rc=0
  "${own[@]}" -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$tmp/bin/gitleaks" git \
    --no-banner --redact=100 --exit-code 3 --log-level error --ignore-gitleaks-allow \
    --config "$config" --log-opts="$SCAN_LOG_OPTS $abase..HEAD" \
    --report-format json --report-path "$tmp/attr-control.json" "$ac" >/dev/null 2>&1 || rc=$?
  py_rc gitleaks-attr-control python3 -I "$HERE/ci_tools.py" gitleaks-report \
    --report "$tmp/attr-control.json" --rc "$rc" --expect-count 1 --expect-commit "$attr_sha" \
    --label 'info attributes control' || die "gitleaks '-diff' attribute positive control failed"

  # Positive control 3: a conflicted merge whose resolution plants a token
  # that neither parent has, under the same '* -diff' attribute. Only the
  # remerge diff shows a resolution, so exactly one finding, from the merge
  # commit, proves merge resolutions are scanned.
  local mc="$tmp/merge-control" cbase merge_sha
  local -a cg=("${own[@]}" git -C "$mc" "${cfg[@]}")
  "${own[@]}" git init -q -b trunk "$mc"
  printf '* -diff\n' >"$mc/.gitattributes"
  printf 'value = base\n' >"$mc/f.txt"
  "${cg[@]}" add .gitattributes f.txt
  "${cg[@]}" commit -q -m base
  cbase=$("${cg[@]}" rev-parse HEAD)
  "${cg[@]}" switch -q -c left
  printf 'value = left\n' >"$mc/f.txt"
  "${cg[@]}" commit -q -am left
  "${cg[@]}" switch -q -c right "$cbase"
  printf 'value = right\n' >"$mc/f.txt"
  "${cg[@]}" commit -q -am right
  rc=0
  "${cg[@]}" merge -q --no-edit left >/dev/null 2>&1 || rc=$?
  ((rc == 1)) || die "merge control: the planted merge did not conflict (exit $rc)"
  plant "$mc/f.txt" $'value = "%s"\n'
  "${cg[@]}" add f.txt
  "${cg[@]}" commit -q --no-edit
  merge_sha=$("${cg[@]}" rev-parse HEAD)
  rc=0
  "${own[@]}" -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$tmp/bin/gitleaks" git \
    --no-banner --redact=100 --exit-code 3 --log-level error --ignore-gitleaks-allow \
    --config "$config" --log-opts="$SCAN_LOG_OPTS $cbase..HEAD" \
    --report-format json --report-path "$tmp/merge-control.json" "$mc" >/dev/null 2>&1 || rc=$?
  py_rc gitleaks-merge-control python3 -I "$HERE/ci_tools.py" gitleaks-report \
    --report "$tmp/merge-control.json" --rc "$rc" --expect-count 1 --expect-commit "$merge_sha" \
    --label 'info merge control' || die 'gitleaks merge-commit positive control failed'

  # Positive control 4: one token in x.svg and one in node_modules/a.js. The
  # default config's global allowlist skips both paths; exactly one finding
  # in each proves the fork's config is in effect and scans them.
  local pc="$tmp/path-control"
  mkdir -m 0700 "$pc" "$pc/node_modules"
  plant "$pc/x.svg" $'<svg><text>token = "%s"</text></svg>\n'
  plant "$pc/node_modules/a.js" $'const token = "%s";\n'
  rc=0
  (cd "$pc" && env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML \
    "$tmp/bin/gitleaks" dir --no-banner --redact=100 --exit-code 3 --log-level error \
    --ignore-gitleaks-allow --config "$config" \
    --report-format json --report-path "$tmp/path-control.json" .) >/dev/null 2>&1 || rc=$?
  py_rc gitleaks-path-control python3 -I "$HERE/ci_tools.py" gitleaks-report \
    --report "$tmp/path-control.json" --rc "$rc" --expect-count 2 \
    --expect-file x.svg --expect-file node_modules/a.js --label 'info path control' ||
    die 'gitleaks path positive control failed (x.svg, node_modules/a.js)'

  local log_opts="HEAD --not $GATE_BASE" ignore=()
  [[ -z $GATE_TARGET ]] || log_opts="$GATE_TARGET..HEAD"
  if git cat-file -e HEAD:ci/sovtech/.gitleaksignore 2>/dev/null; then
    ignore=(--gitleaks-ignore-path ci/sovtech/.gitleaksignore)
  fi
  rc=0
  env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$tmp/bin/gitleaks" git \
    --no-banner --redact=100 --exit-code 3 --log-level error \
    --ignore-gitleaks-allow --config "$config" --log-opts="$SCAN_LOG_OPTS $log_opts" "${ignore[@]}" \
    --report-format json --report-path "$tmp/report.json" . >"$tmp/log" 2>&1 || rc=$?
  if ((rc != 0 && rc != 3)); then
    tail -n 5 "$tmp/log" | cut -c1-300 | LC_ALL=C tr -cd '\11\12\40-\176'
  fi
  printf 'gitleaks: range %s %s, config ci/sovtech/gitleaks.toml\n' "$SCAN_LOG_OPTS" "$log_opts"
  py_rc gitleaks python3 -I "$HERE/ci_tools.py" gitleaks-report \
    --report "$tmp/report.json" --rc "$rc"
}

step_overlay_history() {
  local release=()
  [[ $GATE_MODE != release ]] || release=(--release)
  py_rc overlay-history python3 -I "$HERE/overlay_guard.py" history \
    --base "$GATE_BASE" "${release[@]}"
}

# The committed brand assets are what gen-brand-assets.py writes, as far as
# that can be known without its laptop-only rasteriser: mark.svg passes the
# allow-list, the SVGs are the composed mark byte for byte, and the PNGs and
# the ICO have the generator's exact layout, maskables inside the safe zone.
step_brand_assets() {
  py_rc brand-assets python3 -I "$HERE/gen-brand-assets.py" --check
}

step_move_maps() {
  py_rc move-maps python3 -I "$HERE/ci_tools.py" move-maps --dist "$GATE_DIST" --out "$GATE_MAPS"
}

step_overlay_dist() {
  py_rc overlay-dist python3 -I "$HERE/overlay_guard.py" dist \
    --base "$GATE_BASE" --dist "$GATE_DIST"
}

step_brand_leak() {
  local flags=()
  case $GATE_MODE in
    release) flags=(--release) ;;
    baseline) flags=(--baseline) ;;
  esac
  py_rc brand-leak python3 -I "$HERE/brand_leak.py" --dist "$GATE_DIST" \
    --allowlist "$HERE/brand-allowlist.json" "${flags[@]}"
}

step_dist_secrets() {
  py_rc dist-secrets python3 -I "$HERE/dist_secrets.py" --dist "$GATE_DIST" --maps "$GATE_MAPS"
}

# ----------------------------------------------------------------- main ---

if [[ ${1:-} == __step ]]; then
  : "${GATE_BASE:?}" "${GATE_MODE:?}" "${GATE_DIST:?}" "${GATE_MAPS:?}"
  : "${GATE_TARGET?}"
  case ${2:-} in
    identity) step_identity ;;
    fork-owned-base) step_fork_owned_base ;;
    upstream-base) step_upstream_base ;;
    gate-change) step_gate_change ;;
    gate-bytecode) step_gate_bytecode ;;
    ci-config) step_ci_config ;;
    gitleaks) step_gitleaks ;;
    overlay-history) step_overlay_history ;;
    brand-assets) step_brand_assets ;;
    move-maps) step_move_maps ;;
    overlay-dist) step_overlay_dist ;;
    brand-leak) step_brand_leak ;;
    dist-secrets) step_dist_secrets ;;
    *) die "unknown step" ;;
  esac
  exit 0
fi

mode=default phase=all dist=dist maps=dist-maps target=""
while (($#)); do
  case $1 in
    --release) mode=release ;;
    --baseline) mode=baseline ;;
    --phase)
      phase=${2:?--phase needs a value}
      shift
      ;;
    --dist)
      dist=${2:?--dist needs a value}
      shift
      ;;
    --maps)
      maps=${2:?--maps needs a value}
      shift
      ;;
    --target)
      target=${2:?--target needs a value}
      shift
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
case $phase in all | history | dist | recheck) ;; *) die "--phase must be all, history, dist or recheck" ;; esac
[[ $mode != baseline || $phase != recheck ]] || die '--baseline cannot be combined with --phase recheck'

top=$(git rev-parse --show-toplevel) || die 'not inside a git work tree'
cd -- "$top"
[[ $(git rev-parse --is-shallow-repository) == false ]] ||
  die 'shallow clone: set GIT_DEPTH to 0, the ranges need full history'
command -v python3 >/dev/null || die 'python3 is required'
git_version=$(git version) || die 'git version failed'
[[ $git_version =~ ^git\ version\ ([0-9]+)\.([0-9]+) ]] || die 'cannot read the git version'
((BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 36))) ||
  die "git >= 2.36 is required (--diff-merges=remerge), found ${git_version#git version }"

base=$(git show HEAD:ci/sovtech/UPSTREAM_BASE) || die 'ci/sovtech/UPSTREAM_BASE missing at HEAD'
is_commit "$base" || die 'UPSTREAM_BASE is not a 40-hex commit present in this clone'
git merge-base --is-ancestor "$base" HEAD || die 'UPSTREAM_BASE is not an ancestor of HEAD'
for rev in "$base" HEAD; do
  roots=$(git rev-list --max-parents=0 "$rev")
  [[ $roots == "$UPSTREAM_ROOT" ]] || die "history of $rev must have the single upstream root"
done

zeros=0000000000000000000000000000000000000000
source_desc=""
if [[ -n $target ]]; then
  target=$(git rev-parse --verify --quiet "$target^{commit}") || die '--target is not a commit'
  source_desc="--target"
elif [[ -n ${CI_MERGE_REQUEST_DIFF_BASE_SHA:-} ]]; then
  target=$CI_MERGE_REQUEST_DIFF_BASE_SHA
  source_desc="merge request diff base"
elif [[ -n ${CI_COMMIT_TAG:-} ]]; then
  # A release tag must point at a commit already on main: otherwise the
  # protected runner would build a deploy artifact from unmerged code.
  git fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main' ||
    die 'tag pipeline: cannot fetch origin main'
  tag_main=$(git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}') ||
    die 'tag pipeline: origin/main missing after fetch'
  git merge-base --is-ancestor HEAD "$tag_main" ||
    die "tag $CI_COMMIT_TAG points at a commit that is not on main"
  source_desc="tag pipeline (on main): whole fork set"
elif [[ -n ${CI_COMMIT_BEFORE_SHA:-} && $CI_COMMIT_BEFORE_SHA != "$zeros" ]] &&
  is_commit "$CI_COMMIT_BEFORE_SHA" &&
  git merge-base --is-ancestor "$CI_COMMIT_BEFORE_SHA" HEAD; then
  target=$CI_COMMIT_BEFORE_SHA
  source_desc="push before-sha"
elif [[ -n ${CI:-} ]]; then
  source_desc="CI without a usable before-sha: whole fork set"
elif origin_main=$(git rev-parse --verify --quiet refs/remotes/origin/main) &&
  git merge-base --is-ancestor "$origin_main" HEAD; then
  target=$origin_main
  source_desc="origin/main"
else
  source_desc="whole fork set"
fi
if [[ -n $target ]]; then
  is_commit "$target" || die 'TARGET is not a commit present in this clone'
  git merge-base --is-ancestor "$target" HEAD || die 'TARGET is not an ancestor of HEAD'
fi

export GATE_BASE=$base GATE_TARGET=$target GATE_MODE=$mode GATE_DIST=$dist GATE_MAPS=$maps
printf 'gate: mode=%s phase=%s head=%s base=%s\n' "$mode" "$phase" \
  "$(git rev-parse --short=12 HEAD)" "${base:0:12}"
printf 'gate: target=%s (%s)\n' "${target:0:12}" "$source_desc"

failed=()
run_step() {
  local rc=0
  printf '\n== %s\n' "$1"
  "$BASH" "$SELF" __step "$1" || rc=$?
  ((rc == 0)) || failed+=("$1")
}

if [[ $mode == baseline ]]; then
  run_step move-maps
  run_step brand-leak
elif [[ $phase == recheck ]]; then
  # The maps were moved out by verify's gate; brand-leak refuses a dist that
  # still holds any, and dist-secrets requires the maps directory.
  run_step overlay-dist
  run_step brand-leak
  run_step dist-secrets
else
  if [[ $phase != dist ]]; then
    run_step identity
    run_step fork-owned-base
    run_step upstream-base
    run_step gate-change
    run_step gate-bytecode
    run_step ci-config
    run_step gitleaks
    run_step overlay-history
    run_step brand-assets
  fi
  if [[ $phase != history ]]; then
    run_step move-maps
    run_step overlay-dist
    run_step brand-leak
    run_step dist-secrets
  fi
fi

echo
if ((${#failed[@]})); then
  printf 'gate: FAILED: %s\n' "${failed[*]}"
  exit 3
fi
echo "gate: passed ($mode, $phase)"
