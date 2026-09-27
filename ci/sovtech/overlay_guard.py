#!/usr/bin/env -S python3 -I
"""Overlay guard for SovTech Git (Python 3 standard library only).

Subcommands:
  base-tree  the UPSTREAM_BASE tree holds no fork-owned path (so no upstream
           commit can have added, changed or deleted one); control: HEAD's
           tree must hold the gate itself.
  history  checks that need only git: shadow-map acked blobs, the
           touched-upstream numstat bound, asset-swap blobs, and that every
           fork-deleted path is still absent at HEAD.
  dist     checks against the built dist: overlay sentinels present, upstream
           markers absent, and the CSP <meta> byte-identical to upstream's
           index.html at UPSTREAM_BASE.

Output is rule ids, paths and counts only. Exit codes: see sovci.py.
"""

import sys

# Isolated mode keeps the script's directory and the working directory off
# sys.path, so a file there cannot stand in for a standard-library module.
# The guard comes before every other import, __future__ included: sys is
# built in, but without -I the next import could already be a planted
# sibling such as argparse.py. Python 3.10 or later: the annotations below
# use X | None, evaluated when each function is defined.
if not sys.flags.isolated or sys.version_info < (3, 10):
    sys.stderr.write("ERROR: run this script with python3 -I (Python 3.10 or later)\n")
    sys.exit(4)
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE

import argparse
import glob
import os
import types


def _load_sibling(name: str):
    """Load ci/sovtech/<name>.py from its source: read the .py file, compile
    it here and run it in a fresh module. No import machinery is involved, so
    no .pyc is ever read (a planted __pycache__ entry, unchecked-hash ones
    included, cannot stand in for the source), and the directory never joins
    sys.path, so no file in it can shadow a standard-library module."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name + ".py")
    with open(path, "rb") as handle:
        source = handle.read()
    module = types.ModuleType("sovtech_" + name)
    module.__file__ = path
    exec(compile(source, path, "exec", dont_inherit=True), module.__dict__)
    return module


sovci = _load_sibling("sovci")
CIError = sovci.CIError

SHADOW_MAP = "ci/sovtech/shadow-map.tsv"
TOUCHED = "ci/sovtech/touched-upstream.txt"
ASSET_SWAPS = "ci/sovtech/asset-swaps.tsv"
FORK_DELETED = "ci/sovtech/fork-deleted.txt"
RELEASE_SHADOW_ROWS = 6


class Report:
    def __init__(self) -> None:
        self.failures = 0

    def fail(self, rule: str, detail: str) -> None:
        self.failures += 1
        print("FAIL %s: %s" % (rule, sovci.safe(detail)))

    def ok(self, rule: str, detail: str) -> None:
        print("ok   %s: %s" % (rule, sovci.safe(detail)))


def load_at_head(path: str, repo: str) -> str:
    data = sovci.read_at("HEAD", path, repo)
    if data is None:
        raise CIError("%s is missing at HEAD" % path)
    return data.decode("utf-8")


def shadow_rows(repo: str) -> list:
    rows = sovci.parse_tsv(
        load_at_head(SHADOW_MAP, repo), sovci.SHADOW_HEADER, SHADOW_MAP
    )
    seen = set()
    for row in rows:
        sovci.check_repo_path(row["upstream_path"], SHADOW_MAP)
        sovci.check_repo_path(row["overlay_path"], SHADOW_MAP)
        if not row["overlay_path"].startswith("src/sovtech/"):
            raise CIError("%s: overlay_path must be under src/sovtech/" % SHADOW_MAP)
        if not sovci.HEX40.fullmatch(row["acked_blob"]):
            raise CIError("%s: acked_blob must be a 40-hex blob id" % SHADOW_MAP)
        if row["upstream_path"] in seen:
            raise CIError("%s: duplicate upstream_path row" % SHADOW_MAP)
        seen.add(row["upstream_path"])
    return rows


def parse_touched(text: str) -> dict:
    budgets = {}
    for line in sovci.meaningful_lines(text, TOUCHED):
        parts = line.split()
        if len(parts) != 2 or not parts[1].isdigit() or int(parts[1]) < 1:
            raise CIError("%s: each entry is '<path> <max changed lines>'" % TOUCHED)
        sovci.check_repo_path(parts[0], TOUCHED)
        if parts[0] in budgets:
            raise CIError("%s: duplicate seam entry" % TOUCHED)
        if sovci.is_fork_owned(parts[0]):
            raise CIError("%s: a fork-owned path is not a seam" % TOUCHED)
        budgets[parts[0]] = int(parts[1])
    return budgets


def diff_records(base: str, repo: str) -> list:
    """(status, added, deleted, path) for base..HEAD, renames split."""
    status_raw = sovci.git(
        "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z",
        base, "HEAD", repo=repo,
    ).decode("utf-8", "surrogateescape")
    numstat_raw = sovci.git(
        "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z",
        base, "HEAD", repo=repo,
    ).decode("utf-8", "surrogateescape")
    tokens = status_raw.split("\0")
    if tokens and tokens[-1] == "":
        tokens.pop()
    if len(tokens) % 2:
        raise CIError("unexpected git diff --name-status output")
    statuses = {}
    for i in range(0, len(tokens), 2):
        statuses[tokens[i + 1]] = tokens[i]
    records = []
    for chunk in numstat_raw.split("\0"):
        if not chunk:
            continue
        parts = chunk.split("\t", 2)
        if len(parts) != 3:
            raise CIError("unexpected git diff --numstat output")
        added, deleted, path = parts
        if path not in statuses:
            raise CIError("numstat and name-status disagree on a path")
        records.append((statuses.pop(path), added, deleted, path))
    if statuses:
        raise CIError("name-status listed paths that numstat did not")
    return records


def fork_owned_in_tree(rev: str, repo: str) -> list:
    """Every path in rev's tree (files, symlinks, submodules) that touches a
    fork-owned path, by the same rule sync_checks.py deny uses."""
    raw = sovci.git("ls-tree", "-r", "-z", "--full-tree", "--name-only", rev, repo=repo)
    paths = raw.decode("utf-8", "surrogateescape").split("\0")
    return [path for path in paths if path and sovci.touches_fork_owned(path)]


def cmd_base_tree(args: argparse.Namespace) -> int:
    repo, base, rep = args.repo, args.base, Report()
    if not sovci.HEX40.fullmatch(base):
        raise CIError("--base must be a 40-hex commit id")
    # Positive control: the same listing must see the fork's own files at HEAD.
    control = fork_owned_in_tree("HEAD", repo)
    for need in ("ci/sovtech/gate.sh", "ci/sovtech/overlay_guard.py", ".gitlab-ci.yml"):
        if need not in control:
            raise CIError("control: the fork-owned listing does not see %s at HEAD" % need)
    found = fork_owned_in_tree(base, repo)
    for path in found:
        rep.fail("fork-owned-in-base", "%s is in the UPSTREAM_BASE tree" % path)
    rep.ok("base-tree", "%d fork-owned path(s) at HEAD, %d in UPSTREAM_BASE" % (len(control), len(found)))
    return sovci.EXIT_FINDINGS if rep.failures else sovci.EXIT_OK


def cmd_history(args: argparse.Namespace) -> int:
    repo, base, rep = args.repo, args.base, Report()
    if not sovci.HEX40.fullmatch(base):
        raise CIError("--base must be a 40-hex commit id")

    # 1. Shadow map: acked blobs equal the current upstream blobs at HEAD.
    rows = shadow_rows(repo)
    for row in rows:
        current = sovci.blob_at("HEAD", row["upstream_path"], repo)
        if current is None:
            rep.fail("shadow-upstream-missing", row["upstream_path"])
        elif current != row["acked_blob"]:
            rep.fail(
                "shadow-blob-stale",
                "%s (upstream changed it; port the change, then bump acked_blob)"
                % row["upstream_path"],
            )
        if sovci.blob_at("HEAD", row["overlay_path"], repo) is None:
            rep.fail("shadow-overlay-missing", row["overlay_path"])
    rep.ok("shadow-map", "%d row(s) checked" % len(rows))
    if args.release and len(rows) != RELEASE_SHADOW_ROWS:
        rep.fail(
            "release-shadow-rows",
            "%d row(s), release needs exactly %d" % (len(rows), RELEASE_SHADOW_ROWS),
        )

    # 2. Asset swaps: HEAD carries the fork's bytes, not upstream's.
    swaps = sovci.parse_tsv(
        load_at_head(ASSET_SWAPS, repo), sovci.ASSET_SWAP_HEADER, ASSET_SWAPS
    )
    swap_paths = set()
    for row in swaps:
        sovci.check_repo_path(row["path"], ASSET_SWAPS)
        if not row["path"].startswith("public/"):
            raise CIError("%s: swaps must be under public/" % ASSET_SWAPS)
        if not sovci.HEX40.fullmatch(row["fork_blob"]):
            raise CIError("%s: fork_blob must be a 40-hex blob id" % ASSET_SWAPS)
        if row["path"] in swap_paths:
            raise CIError("%s: duplicate path row" % ASSET_SWAPS)
        swap_paths.add(row["path"])
        head_blob = sovci.blob_at("HEAD", row["path"], repo)
        if head_blob != row["fork_blob"]:
            rep.fail("asset-swap-reverted", row["path"])
        if sovci.blob_at(base, row["path"], repo) == row["fork_blob"]:
            rep.fail("asset-swap-dead-row", "%s equals upstream" % row["path"])
    rep.ok("asset-swaps", "%d row(s) checked" % len(swaps))

    # 3. Fork-deleted paths stay deleted.
    deleted = sovci.parse_fork_deleted(load_at_head(FORK_DELETED, repo), FORK_DELETED)
    tree = sovci.git("ls-tree", "-r", "-z", "--name-only", "HEAD", repo=repo)
    present = 0
    for path in tree.decode("utf-8", "surrogateescape").split("\0"):
        if path and sovci.covered_by(path, deleted):
            present += 1
            rep.fail("fork-deleted-present", path)
    rep.ok("fork-deleted", "%d entr(ies), %d present" % (len(deleted), present))

    # 4. Numstat bound over upstream paths.
    budgets = parse_touched(load_at_head(TOUCHED, repo))
    used = set()
    checked = 0
    for status, added, removed, path in diff_records(base, repo):
        if sovci.is_fork_owned(path) or path in swap_paths:
            continue
        if status == "D" and sovci.covered_by(path, deleted):
            continue
        checked += 1
        if path not in budgets:
            rep.fail("upstream-edit-unlisted", "%s (status %s)" % (path, status))
            continue
        used.add(path)
        if added == "-" or removed == "-":
            rep.fail("upstream-edit-binary", path)
            continue
        changed = int(added) + int(removed)
        if changed > budgets[path]:
            rep.fail(
                "upstream-edit-over-budget",
                "%s changed %d > budget %d" % (path, changed, budgets[path]),
            )
    for path in sorted(set(budgets) - used):
        rep.fail("touched-upstream-dead-entry", "%s is listed but unchanged" % path)
    rep.ok(
        "touched-upstream",
        "%d upstream path(s) changed, %d seam(s) listed" % (checked, len(budgets)),
    )
    return sovci.EXIT_FINDINGS if rep.failures else sovci.EXIT_OK


def read_file(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def cmd_dist(args: argparse.Namespace) -> int:
    repo, base, dist, rep = args.repo, args.base, args.dist, Report()
    if not sovci.HEX40.fullmatch(base):
        raise CIError("--base must be a 40-hex commit id")
    if not os.path.isdir(dist) or os.path.islink(dist):
        raise CIError("dist directory is missing")
    scripts = sorted(glob.glob(os.path.join(dist, "assets", "*.js")))
    if len(scripts) < args.min_js:
        raise CIError(
            "dist/assets has %d .js file(s), floor is %d" % (len(scripts), args.min_js)
        )
    bundles = [read_file(path) for path in scripts]

    rows = shadow_rows(repo)
    for row in rows:
        sentinel = row["sentinel"].encode("utf-8")
        marker = row["upstream_marker"].encode("utf-8")
        hits = sum(1 for blob in bundles if sentinel in blob)
        if hits == 0:
            rep.fail("overlay-sentinel-missing", row["overlay_path"])
        leaks = sum(1 for blob in bundles if marker in blob)
        if leaks:
            rep.fail(
                "upstream-marker-present",
                "%s marker in %d bundle(s)" % (row["upstream_path"], leaks),
            )
    rep.ok("overlay-sentinels", "%d row(s), %d bundle(s)" % (len(rows), len(bundles)))

    upstream_html = sovci.read_at(base, "index.html", repo)
    if upstream_html is None:
        raise CIError("index.html is missing at UPSTREAM_BASE")
    upstream_csp = sovci.csp_meta_elements(upstream_html)
    if len(upstream_csp) != 1:
        raise CIError("upstream index.html has %d CSP metas" % len(upstream_csp))
    pages = [p for p in ("index.html", "404.html") if os.path.isfile(os.path.join(dist, p))]
    if "index.html" not in pages:
        raise CIError("dist/index.html is missing")
    for page in pages:
        built = sovci.csp_meta_elements(read_file(os.path.join(dist, page)))
        if len(built) != 1:
            rep.fail("csp-meta-count", "%s has %d CSP metas" % (page, len(built)))
        elif built[0] != upstream_csp[0]:
            rep.fail("csp-meta-changed", "%s differs from upstream index.html" % page)
    rep.ok("csp-meta", "%d page(s) compared" % len(pages))
    return sovci.EXIT_FINDINGS if rep.failures else sovci.EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("base-tree", "history", "dist"):
        p = sub.add_parser(name)
        p.add_argument("--repo", default=".")
        p.add_argument("--base", required=True, help="UPSTREAM_BASE commit id")
        if name != "base-tree":
            p.add_argument("--release", action="store_true")
        if name == "dist":
            p.add_argument("--dist", required=True)
            p.add_argument("--min-js", type=int, default=5)
    args = parser.parse_args()
    try:
        if args.command == "base-tree":
            return cmd_base_tree(args)
        if args.command == "history":
            return cmd_history(args)
        return cmd_dist(args)
    except (CIError, OSError, UnicodeDecodeError) as exc:
        print("ERROR overlay-guard: %s" % sovci.safe(str(exc)))
        return sovci.EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
