#!/usr/bin/env bash
# Release packaging for sovtech-v* tags. Packs the dist the verify job tested
# (never a rebuild) into a deterministic tarball.
#
# Usage: ci/sovtech/package.sh site DIST TOOLCHAIN_RECORD OUT_DIR
#        ci/sovtech/package.sh maps MAPS_DIR OUT_DIR
#
# site: OUT_DIR/sovtech-git-<tag>.tar.gz (*.map excluded, build-info.json at
#       its root), OUT_DIR/build-info.json and OUT_DIR/SHA256SUMS.
# maps: OUT_DIR/sovtech-git-<tag>-maps.tar.gz and OUT_DIR/SHA256SUMS, a
#       separate artifact that is never deployed.
#
# Deterministic: tar --sort=name, owner/group 0, --mtime=@SOURCE_DATE_EPOCH
# (the tag commit's committer time), normalised modes, gzip -n. The script
# builds each tarball twice and requires identical bytes.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1 LC_ALL=C

HERE=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
readonly HERE

die() {
  printf 'ERROR package: %s\n' "$*" >&2
  exit 4
}

make_tar() { # SRC_DIR OUT_FILE [EXTRA_TAR_ARGS...]
  local src=$1 dest=$2
  shift 2
  tar --create --file=- --directory="$src" --format=gnu --sort=name \
    --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
    --mode='u=rwX,go=rX' "$@" . | gzip -n -9 >"$dest"
}

# Fail unless SRC holds only regular files and directories, with a floor.
assert_plain_tree() { # SRC_DIR MIN_FILES
  local odd files
  odd=$(find "$1" ! -type f ! -type d -printf 'x\n' | wc -l)
  ((odd == 0)) || die "$odd entr(ies) in $1 are neither files nor directories"
  files=$(find "$1" -type f -printf 'x\n' | wc -l)
  ((files >= $2)) || die "$1 has $files file(s), floor is $2"
}

# Fail unless the tarball lists only regular files and directories, all
# relative, with no parent-directory components.
assert_listing() { # TARBALL
  local listing bad
  listing=$(tar -tvzf "$1")
  bad=$(awk '{ t = substr($1, 1, 1); if (t != "-" && t != "d") n++ } END { print n + 0 }' <<<"$listing")
  ((bad == 0)) || die "tarball lists $bad entr(ies) that are not files or directories"
  local names rc=0
  names=$(tar -tzf "$1")
  grep -qE '^/|(^|/)\.\.(/|$)' <<<"$names" || rc=$?
  case $rc in
    1) ;;
    0) die 'tarball holds an absolute or parent-directory path' ;;
    *) die "grep exited $rc" ;;
  esac
}

pack() { # SRC OUT_FILE [EXTRA_TAR_ARGS...]
  local src=$1 dest=$2
  shift 2
  make_tar "$src" "$dest" "$@"
  make_tar "$src" "$dest.again" "$@"
  cmp -s -- "$dest" "$dest.again" || die "tarball $(basename -- "$dest") is not reproducible"
  rm -f -- "$dest.again"
  assert_listing "$dest"
}

tag=${CI_COMMIT_TAG:?package runs on sovtech-v* tag pipelines only}
[[ $tag =~ ^sovtech-v[0-9A-Za-z.+-]+$ ]] || die 'not a sovtech-v* tag'
head=$(git rev-parse --verify 'HEAD^{commit}')
[[ ${CI_COMMIT_SHA:?} == "$head" ]] || die 'CI_COMMIT_SHA is not the checked-out commit'
tar_version=$(tar --version)
[[ $tar_version == *"GNU tar"* ]] || die 'GNU tar is required'
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct HEAD)
[[ $SOURCE_DATE_EPOCH =~ ^[0-9]+$ ]] || die 'bad SOURCE_DATE_EPOCH'
export SOURCE_DATE_EPOCH

kind=${1:?usage: package.sh site|maps ...}
case $kind in
  site)
    dist=${2:?} record=${3:?} out=${4:?}
    [[ -d $dist && ! -L $dist ]] || die 'dist is missing'
    [[ ! -e $dist/build-info.json ]] || die 'dist already has a build-info.json'
    maps=$(find "$dist" -name '*.map' -printf 'x\n' | wc -l)
    ((maps == 0)) || die 'dist still holds source maps; the gate moves them out'
    assert_plain_tree "$dist" 10
    node="" pnpm=""
    while IFS='=' read -r key value; do
      case $key in
        node) node=$value ;;
        pnpm) pnpm=$value ;;
      esac
    done <"$record"
    base=$(git show HEAD:ci/sovtech/UPSTREAM_BASE)
    mkdir -p -- "$out"
    python3 -I "$HERE/ci_tools.py" build-info --out "$out/build-info.json" --tag "$tag" \
      --commit "$head" --upstream-base "$base" --node "$node" --pnpm "$pnpm" \
      --pipeline-id "${CI_PIPELINE_ID:?}" --source-date-epoch "$SOURCE_DATE_EPOCH"
    cp -- "$out/build-info.json" "$dist/build-info.json"
    name="sovtech-git-$tag.tar.gz"
    pack "$dist" "$out/$name" --exclude='*.map'
    (cd -- "$out" && sha256sum -- "$name" build-info.json >SHA256SUMS &&
      sha256sum --check --strict --quiet SHA256SUMS)
    ;;
  maps)
    maps_dir=${2:?} out=${3:?}
    [[ -d $maps_dir && ! -L $maps_dir ]] || die 'maps directory is missing'
    assert_plain_tree "$maps_dir" 1
    others=$(find "$maps_dir" -type f ! -name '*.map' -printf 'x\n' | wc -l)
    ((others == 0)) || die 'the maps directory holds files that are not source maps'
    mkdir -p -- "$out"
    name="sovtech-git-$tag-maps.tar.gz"
    pack "$maps_dir" "$out/$name"
    (cd -- "$out" && sha256sum -- "$name" >SHA256SUMS &&
      sha256sum --check --strict --quiet SHA256SUMS)
    ;;
  *) die 'kind must be site or maps' ;;
esac
printf 'package: %s written with SOURCE_DATE_EPOCH=%s\n' "$name" "$SOURCE_DATE_EPOCH"
