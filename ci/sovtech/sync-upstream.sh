#!/usr/bin/env bash
# Upstream sync for SovTech Git (weekly, or ad hoc for security fixes).
#
# Usage: ci/sovtech/sync-upstream.sh               # prepare a sync branch
#        ci/sovtech/sync-upstream.sh --push        # ... and push it as an MR
#        ci/sovtech/sync-upstream.sh --finish [--push]
#                                                  # after resolving conflicts
#        ci/sovtech/sync-upstream.sh --report-only [--fork-ref REV]
#
# Sync (laptop, in a clean checkout; Cameron runs it):
#   1. assert the upstream remote is Dan's npub over nostr:// with push
#      DISABLED, fetch upstream main and origin main, and cross-check
#      refs/heads/main on both GRASP servers (gitnostr.com, relay.ngit.dev);
#   2. take the rules (sync_checks.py, sovci.py) from the fork head, never
#      from the working tree, refuse any __pycache__ or .pyc among them,
#      prove them byte-identical to its blobs, and run them with python3 -I:
#      nothing from the tree being merged ever runs;
#   3. refuse unless the new head descends from UPSTREAM_BASE and the only
#      root is 19dd6a87;
#   4. refuse any upstream change to a fork-owned path (ci/sovtech/,
#      src/sovtech/, SOVTECH.md, ...), apply agent-config deny-by-default
#      (ci/sovtech/agent-config-allow.txt), and print the security-sensitive
#      paths for review;
#   5. branch sync/upstream-<sha8> from origin/main, merge --no-ff as
#      "sovtech <git@sovit.xyz>", re-delete every fork-deleted.txt entry as a
#      literal path, and stop for a person on any unresolved path;
#   6. prove every fork-owned path still equals the fork head's, print the
#      drift report, bump UPSTREAM_BASE as sovITxyz, and print the push command
#      (or run it with --push).
#
# --finish re-runs steps 1 to 4 for the merge being finished: the freshly
# fetched upstream main and origin/main must still be its parents 2 and 1,
# and the branch name must carry that upstream head's sha8. Then step 6.
#
# --report-only (the CI drift job) fetches, runs every check and a trial merge
# in a throwaway worktree, prints the report and changes nothing. Without the
# nostr helper (git-remote-nostr, absent on CI runners) it fetches from the two
# GRASP https URLs instead and requires them to agree. It reads no secrets.
set -euo pipefail

readonly DAN_NPUB=npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr
readonly UPSTREAM_PREFIX="nostr://$DAN_NPUB/"
readonly UPSTREAM_ROOT=19dd6a8781c9b3a37d21f4655c94b08791b9d0f4
readonly GRASP_URLS=(
  "https://gitnostr.com/$DAN_NPUB/gitworkshop.git"
  "https://relay.ngit.dev/$DAN_NPUB/gitworkshop.git"
)
readonly FORK_NAME=sovITxyz MERGE_NAME=sovtech EMAIL=git@sovit.xyz
readonly PRIV_REFS=refs/sovtech-sync
export PYTHONDONTWRITEBYTECODE=1 GIT_TERMINAL_PROMPT=0

die() {
  printf 'ERROR sync-upstream: %s\n' "$*" >&2
  exit 4
}

# The identity env vars override -c user.*; strip them for every commit.
git_as() {
  local name=$1
  shift
  env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
    git -c "user.name=$name" -c "user.email=$EMAIL" "$@"
}

assert_head_identity() {
  local want="$1 <$EMAIL>" got
  got=$(git log -1 --format='%an <%ae>|%cn <%ce>')
  [[ $got == "$want|$want" ]] || die "HEAD is not authored and committed as $want"
}

is_commit() {
  [[ $1 =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$1^{commit}" 2>/dev/null
}

# https-only git without any credential helper, so no CI token can reach a
# GRASP server.
git_public() {
  git -c credential.helper= -c protocol.allow=never -c protocol.https.allow=always "$@"
}

mode=sync push=0 fork_ref=""
while (($#)); do
  case $1 in
    --report-only) mode=report ;;
    --finish) mode=finish ;;
    --push) push=1 ;;
    --fork-ref)
      fork_ref=${2:?--fork-ref needs a value}
      shift
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[[ $mode != report || $push == 0 ]] || die '--push cannot be combined with --report-only'
[[ -z $fork_ref || $mode == report ]] || die '--fork-ref is only for --report-only'

top=$(git rev-parse --show-toplevel) || die 'not inside a git work tree'
cd -- "$top"
[[ $(git rev-parse --is-shallow-repository) == false ]] || die 'shallow clone: full history is required'
command -v python3 >/dev/null || die 'python3 is required'
command -v curl >/dev/null || die 'curl is required'
command -v tar >/dev/null || die 'tar is required'

tmp=$(mktemp -d)
trial=""
cleanup() {
  if [[ -n $trial ]]; then
    git worktree remove --force "$trial" >/dev/null 2>&1 || true
    git worktree prune >/dev/null 2>&1 || true
  fi
  local ref refs
  refs=$(git for-each-ref --format='%(refname)' "$PRIV_REFS/" 2>/dev/null || true)
  for ref in $refs; do git update-ref -d "$ref" || true; done
  rm -rf -- "$tmp"
}
trap cleanup EXIT

# --------------------------------------------------------------- finish ---
# Resume after a person resolved the conflicts and committed the merge. What
# the merge claims is read here; the fetch below must then confirm it.
if [[ $mode == finish ]]; then
  branch=$(git symbolic-ref --quiet --short HEAD) || die 'HEAD is detached'
  [[ $branch =~ ^sync/upstream-([0-9a-f]{8})$ ]] || die 'run --finish on the sync/upstream-<sha8> branch'
  branch_sha8=${BASH_REMATCH[1]}
  [[ -z $(git status --porcelain --untracked-files=no) ]] || die 'working tree is not clean'
  merged_new=$(git rev-parse --verify --quiet 'HEAD^2^{commit}') || die 'HEAD is not the sync merge'
  if git rev-parse --verify --quiet 'HEAD^3' >/dev/null; then
    die 'the sync merge must have exactly two parents'
  fi
  merged_fork=$(git rev-parse --verify 'HEAD^1^{commit}')
  [[ ${merged_new:0:8} == "$branch_sha8" ]] || die 'the branch name does not match the merged upstream head'
  assert_head_identity "$MERGE_NAME"
fi

# ---------------------------------------------------------------- fetch ---
helper=0
command -v git-remote-nostr >/dev/null && helper=1
upstream_url=$(git remote get-url upstream 2>/dev/null || true)
if [[ -n $upstream_url ]]; then
  [[ $upstream_url == "$UPSTREAM_PREFIX"* ]] || die "upstream remote is not $UPSTREAM_PREFIX…"
  [[ $(git remote get-url --push upstream) == DISABLED ]] || die 'upstream push URL must be DISABLED'
fi
if ((helper)) && [[ -n $upstream_url ]]; then
  via=nostr
elif [[ $mode == report ]]; then
  via=grasp
  echo 'note: git-remote-nostr or the upstream remote is absent; fetching from the two GRASP https URLs, which must agree'
else
  die 'a sync needs git-remote-nostr and the upstream remote'
fi

if [[ $via == nostr ]]; then
  if [[ $mode == report ]]; then
    git fetch --quiet --no-tags upstream "+refs/heads/main:$PRIV_REFS/upstream-main"
    new=$(git rev-parse --verify "$PRIV_REFS/upstream-main^{commit}")
  else
    git fetch --quiet --no-tags upstream +refs/heads/main:refs/remotes/upstream/main
    new=$(git rev-parse --verify 'refs/remotes/upstream/main^{commit}')
  fi
else
  i=0 new=""
  for url in "${GRASP_URLS[@]}"; do
    git_public fetch --quiet --no-tags "$url" "+refs/heads/main:$PRIV_REFS/grasp-$i"
    got=$(git rev-parse --verify "$PRIV_REFS/grasp-$i^{commit}")
    [[ -z $new || $got == "$new" ]] || die 'the two GRASP servers disagree on refs/heads/main'
    new=$got i=$((i + 1))
  done
fi

# The fork head: what the sync builds on, and where every rule comes from.
if [[ $mode == report ]]; then
  if [[ -n $fork_ref ]]; then
    fork_head=$(git rev-parse --verify "$fork_ref^{commit}")
  elif [[ -n ${CI:-} ]]; then
    fork_head=$(git rev-parse --verify 'HEAD^{commit}')
  else
    fork_head=$(git rev-parse --verify 'refs/remotes/origin/main^{commit}') ||
      die 'no origin/main; pass --fork-ref'
  fi
else
  git fetch --quiet --no-tags origin +refs/heads/main:refs/remotes/origin/main
  fork_head=$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')
fi
if [[ $mode == finish ]]; then
  [[ $new == "$merged_new" ]] ||
    die 'upstream main is not the merged head (it moved, or the merge is of something else): regenerate the sync branch'
  [[ $fork_head == "$merged_fork" ]] ||
    die "origin/main is not the merge's first parent (main moved): regenerate the sync branch"
fi

# The rules always come from the fork head, never from the working tree: after
# a merge that tree holds upstream's files, and before one it is whatever
# happens to be checked out. git archive applies the fork head's
# .gitattributes (an upstream file), so every extracted file is proved
# byte-identical to its blob before anything runs.
RULES=""
extract_rules() {
  local dest="$tmp/rules" listing line meta path mode type oid n=0 files lower
  local bytecode='(^|/)__pycache__(/|$)'
  listing=$(git -c core.quotePath=true ls-tree -r --full-tree "$fork_head" -- ci/sovtech) ||
    die 'cannot list ci/sovtech at the fork head'
  [[ -n $listing ]] || die 'the fork head has no ci/sovtech'
  while IFS= read -r line; do
    meta=${line%%$'\t'*} path=${line#*$'\t'}
    read -r mode type oid <<<"$meta"
    [[ $type == blob && $mode =~ ^100(644|755)$ ]] ||
      die "the fork head's ci/sovtech holds an entry that is not a plain file"
    # No bytecode is ever extracted: the scripts compile sovci.py from its
    # source, and a __pycache__ entry or .pyc file is refused outright.
    lower=${path,,}
    [[ ! $lower =~ $bytecode && $lower != *.pyc && $lower != *.pyc\" ]] ||
      die "the fork head's ci/sovtech holds bytecode (__pycache__ or .pyc)"
  done <<<"$listing"
  mkdir -m 0700 -- "$dest"
  git archive --format=tar -o "$tmp/rules.tar" "$fork_head" -- ci/sovtech ||
    die 'git archive of the fork head rules failed'
  tar -x -f "$tmp/rules.tar" -C "$dest" --no-same-owner --no-same-permissions ||
    die 'could not unpack the fork head rules'
  while IFS= read -r line; do
    meta=${line%%$'\t'*} path=${line#*$'\t'}
    read -r mode type oid <<<"$meta"
    [[ $path == ci/sovtech/* && -f $dest/$path && ! -L $dest/$path ]] ||
      die "rules extraction lost $path"
    [[ $(git hash-object --no-filters -- "$dest/$path") == "$oid" ]] ||
      die "rules extraction changed $path (a .gitattributes conversion?)"
    n=$((n + 1))
  done <<<"$listing"
  files=$(find "$dest" ! -type d -printf 'x\n' | wc -l)
  ((files == n)) || die 'rules extraction produced entries the fork head does not have'
  RULES="$dest/ci/sovtech"
  printf 'rules: %d file(s) from fork head %s, each equal to its blob\n' "$n" "${fork_head:0:12}"
}
extract_rules

# Cross-check refs/heads/main on both GRASP servers: capture, then compare.
i=0
for url in "${GRASP_URLS[@]}"; do
  curl -fsS --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 60 -o "$tmp/refs-$i" \
    "$url/info/refs?service=git-upload-pack" || die "GRASP server $i did not answer"
  sha=$(python3 -I "$RULES/sync_checks.py" refs --file "$tmp/refs-$i") ||
    die "GRASP server $i sent no usable refs/heads/main"
  [[ $sha == "$new" ]] || die "GRASP server $i advertises a different refs/heads/main"
  i=$((i + 1))
done
printf 'upstream main %s (via %s; both GRASP servers agree)\n' "${new:0:12}" "$via"

base=$(git show "$fork_head:ci/sovtech/UPSTREAM_BASE")
is_commit "$base" || die 'UPSTREAM_BASE at the fork head is not a commit'
printf 'fork head %s, UPSTREAM_BASE %s\n' "${fork_head:0:12}" "${base:0:12}"

git merge-base --is-ancestor "$base" "$new" ||
  die 'refusing: upstream main does not descend from UPSTREAM_BASE (rewritten history?)'
roots=$(git rev-list --max-parents=0 "$new")
[[ $roots == "$UPSTREAM_ROOT" ]] || die 'refusing: upstream history must have the single root 19dd6a87'
if [[ $new == "$base" ]]; then
  [[ $mode != finish ]] || die 'nothing to finish: the merged head equals UPSTREAM_BASE'
  echo 'up to date: upstream main equals UPSTREAM_BASE'
  exit 0
fi
echo "note: Dan's announced earliest-unique-commit is not read here; check it with ngit before merging"

echo
echo '== fork-owned paths and agent-config deny-by-default'
git show "$fork_head:ci/sovtech/agent-config-allow.txt" >"$tmp/allow.txt"
deny_rc=0
python3 -I "$RULES/sync_checks.py" deny --base "$base" --new "$new" \
  --rules-rev "$fork_head" --allowlist "$tmp/allow.txt" || deny_rc=$?
case $deny_rc in
  0) ;;
  3) [[ $mode == report ]] || die 'refused: upstream touches fork-owned or agent-config paths (see above)' ;;
  *) die 'the deny check could not run' ;;
esac

echo
echo '== security-sensitive paths'
python3 -I "$RULES/sync_checks.py" security --base "$base" --new "$new" ||
  die 'the security listing could not run'

# Fork-deleted entries from the fork head, checked for shape before use, then
# used as literal paths (GIT_LITERAL_PATHSPECS): no glob or pathspec magic.
# -f is required: a file upstream adds under a deleted directory merges in
# cleanly as a staged addition, and plain git rm refuses staged changes. The
# tree is clean before the merge, so -f can only drop what the merge brought.
deleted=$(git show "$fork_head:ci/sovtech/fork-deleted.txt")
fork_deleted_paths() {
  local line
  while IFS= read -r line; do
    [[ -n $line && $line != \#* ]] || continue
    [[ $line != /* && $line != *..* && $line != *' '* ]] || die 'bad fork-deleted.txt entry'
    case $line in
      *[\*\?\[\\:]*) die 'fork-deleted.txt entries must not contain any of * ? [ \ :' ;;
    esac
    printf '%s\n' "${line%/}"
  done <<<"$deleted"
}
deleted_paths=$(fork_deleted_paths) || exit 4
[[ -n $deleted_paths ]] || die 'fork-deleted.txt has no entries'

redelete() {
  local dir=$1 path left
  while IFS= read -r path; do
    GIT_LITERAL_PATHSPECS=1 git -C "$dir" rm -r -f -q --ignore-unmatch -- "$path" ||
      die "could not re-delete fork-deleted path: $path"
    left=$(GIT_LITERAL_PATHSPECS=1 git -C "$dir" ls-files -- "$path")
    [[ -z $left ]] || die "fork-deleted path still tracked: $path"
  done <<<"$deleted_paths"
}

# The merge must leave every fork-owned path exactly as the fork head has it:
# deny proved upstream never touches one, and this proves the person who
# resolved a conflict did not either. It also proves that this script, which
# the merged tree now holds, is the fork head's own.
assert_owned_unchanged() {
  local rc=0
  python3 -I "$RULES/sync_checks.py" owned --base "$fork_head" \
    --new "$(git rev-parse --verify 'HEAD^{commit}')" || rc=$?
  case $rc in
    0) ;;
    3) die 'the merge changed fork-owned path(s) (see above)' ;;
    *) die 'the fork-owned check could not run' ;;
  esac
}

# ----------------------------------------------------------- report-only ---
if [[ $mode == report ]]; then
  echo
  echo '== trial merge (throwaway worktree)'
  trial="$tmp/trial"
  git worktree add --quiet --detach "$trial" "$fork_head"
  merge_rc=0
  git_as "$MERGE_NAME" -C "$trial" merge --quiet --no-ff --no-commit --log "$new" \
    >/dev/null 2>&1 || merge_rc=$?
  mh=$(git -C "$trial" rev-parse --verify --quiet MERGE_HEAD) || die 'the trial merge did not start'
  [[ $mh == "$new" ]] || die 'the trial merge picked the wrong head'
  redelete "$trial"
  unresolved=$(git -C "$trial" -c core.quotePath=true diff --name-only --diff-filter=U)
  if [[ -n $unresolved ]]; then
    printf 'CONFLICT: a sync needs a person for %d path(s):\n' "$(wc -l <<<"$unresolved")"
    sed 's/^/  /' <<<"$unresolved"
  else
    printf 'clean: the merge (exit %d) resolves once fork-deleted paths are removed\n' "$merge_rc"
  fi
  git -C "$trial" merge --abort >/dev/null 2>&1 || true
  echo
  python3 -I "$RULES/sync_checks.py" drift --base "$base" --new "$new" --rules-rev "$fork_head" ||
    die 'the drift report could not run'
  ((deny_rc == 0)) || {
    echo 'report: fork-owned or agent-config paths were refused; a sync would stop'
    exit 3
  }
  echo 'report: done, nothing changed'
  exit 0
fi

# ------------------------------------------------------------ sync merge ---
if [[ $mode == sync ]]; then
  [[ -z $(git status --porcelain --untracked-files=no) ]] || die 'working tree is not clean'
  branch="sync/upstream-${new:0:8}"
  if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    die "branch $branch already exists; delete it or use --finish"
  fi
  git switch --quiet --no-track -c "$branch" "$fork_head"
  [[ $(git rev-parse refs/remotes/upstream/main) == "$new" ]] || die 'upstream/main moved during the sync'
  # git merge names upstream paths as they are, control characters included:
  # capture its output and print it through sovci.safe(), never raw.
  merge_rc=0
  git_as "$MERGE_NAME" merge --no-ff --no-commit --log upstream/main >"$tmp/merge.log" 2>&1 ||
    merge_rc=$?
  python3 -I "$RULES/sync_checks.py" print --file "$tmp/merge.log" ||
    die 'could not print the merge output'
  mh=$(git rev-parse --verify --quiet MERGE_HEAD) || die "the merge did not start (exit $merge_rc)"
  [[ $mh == "$new" ]] || die 'the merge picked the wrong head'
  redelete .
  unresolved=$(git -c core.quotePath=true diff --name-only --diff-filter=U)
  if [[ -n $unresolved ]]; then
    printf 'STOP: %d unresolved path(s) need a person:\n' "$(wc -l <<<"$unresolved")"
    sed 's/^/  /' <<<"$unresolved"
    cat <<EOF

Resolve them (seams: ci/sovtech/touched-upstream.txt; never take "theirs"
for a path in asset-swaps.tsv; never edit a fork-owned path), git add them,
run git status, then:
  env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \\
    git -c user.name=$MERGE_NAME -c user.email=$EMAIL commit --no-edit
  ci/sovtech/sync-upstream.sh --finish
EOF
    exit 2
  fi
  git status --short --untracked-files=no | wc -l | sed 's/^/staged path(s): /'
  git_as "$MERGE_NAME" commit --quiet --no-edit
  assert_head_identity "$MERGE_NAME"
  [[ $(git rev-parse 'HEAD^1') == "$fork_head" && $(git rev-parse 'HEAD^2') == "$new" ]] ||
    die 'the merge commit has the wrong parents'
  printf 'merged upstream %s as %s <%s>\n' "${new:0:12}" "$MERGE_NAME" "$EMAIL"
fi

# --finish: the person's resolution must also have kept the deletions.
if [[ $mode == finish ]]; then
  while IFS= read -r path; do
    left=$(GIT_LITERAL_PATHSPECS=1 git ls-files -- "$path")
    [[ -z $left ]] ||
      die "fork-deleted path still tracked: $path (git rm it, git commit --amend the unpushed merge, then --finish)"
  done <<<"$deleted_paths"
fi

# ---------------------------------------------------- drift, bump, push ---
assert_owned_unchanged
echo
python3 -I "$RULES/sync_checks.py" drift --base "$base" --new "$new" --rules-rev "$fork_head" ||
  die 'the drift report could not run'

count=$(git rev-list --count "$base..$new")
printf '%s\n' "$new" >ci/sovtech/UPSTREAM_BASE
git add -- ci/sovtech/UPSTREAM_BASE
git -c core.quotePath=true status --short --untracked-files=no
staged=$(git diff --cached --name-only)
[[ $staged == ci/sovtech/UPSTREAM_BASE ]] || die 'something other than UPSTREAM_BASE is staged'
git_as "$FORK_NAME" commit --quiet \
  -m "chore(sovtech): bump UPSTREAM_BASE to ${new:0:8}" \
  -m "Upstream main $new, $count new upstream commit(s)."
assert_head_identity "$FORK_NAME"

branch=$(git symbolic-ref --quiet --short HEAD)
push_cmd=(git push
  -o merge_request.create
  -o merge_request.target=main
  -o merge_request.label=upstream-sync
  -o merge_request.remove_source_branch
  -o "merge_request.title=Upstream sync ${new:0:8}"
  -o "merge_request.description=Upstream sync to ${new:0:12} ($count commits). Merge method: fast-forward onto main via the SHA-pinned API merge; never squash, never rebase; regenerate the branch if main moved."
  origin "$branch")
echo
if ((push)); then
  "${push_cmd[@]}"
else
  echo 'Review the drift report above, then push the sync MR with:'
  printf ' %q' "${push_cmd[@]}"
  echo
fi
