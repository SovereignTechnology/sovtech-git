#!/usr/bin/env -S python3 -I
"""Overlay guard for SovTech Git (Python 3 standard library only).

Subcommands:
  base-tree  the UPSTREAM_BASE tree holds no fork-owned path (so no upstream
           commit can have added, changed or deleted one); control: HEAD's
           tree must hold the gate itself.
  history  checks that need only git: shadow-map acked blobs, the
           touched-upstream numstat bound, asset-swap blobs, that every
           fork-deleted path is still absent at HEAD, and that upstream's
           palette (the :root and .dark blocks of src/index.css) still has
           the sha256 recorded in upstream-palette.sha256.
  dist     checks against the built dist: overlay sentinels present, upstream
           markers absent, the CSP <meta> byte-identical to upstream's
           index.html at UPSTREAM_BASE, and the theme order: theme.css's
           palette is the last one in the one stylesheet that declares
           palette variables, and every page loads that stylesheet.

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
import bisect
import glob
import hashlib
import os
import re
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
PALETTE_SHA = "ci/sovtech/upstream-palette.sha256"
UPSTREAM_CSS = "src/index.css"
RELEASE_SHADOW_ROWS = 6
HEX64 = re.compile(r"[0-9a-f]{64}")

# Upstream's palette: every :root or .dark block of src/index.css with its
# body, joined as "selector{body}" lines. src/sovtech/theme.css redefines
# each of these variables, so an upstream change must be ported before the
# recorded digest moves.
PALETTE_BLOCK = re.compile(r"(^|\s)(:root|\.dark)\s*\{([^}]*)\}", re.ASCII)
VARIABLE_NAME = re.compile(r"--([\w-]+)\s*:", re.ASCII)

# The theme order in dist. A custom property declaration: "--name:" not
# preceded by a name character (so "--tw-ring" never reads as "--ring").
DIST_DECLARATION = re.compile(rb"(?<![\w-])--([\w-]+)\s*:")
CSS_DECLARATION = re.compile(r"(?<![\w-])--([\w-]+)\s*:", re.ASCII)
CSS_STRUCTURE = re.compile(r"[{};]")
CSS_VALUE_END = re.compile(r"[;}]")
IMPORTANT = re.compile(r"!\s*important", re.IGNORECASE | re.ASCII)
LINK_TAG = re.compile(rb"<link\b([^>]*)>", re.IGNORECASE)
TAG_ATTRIBUTE = re.compile(
    rb"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+))"
)
# theme.css's two blocks open with these color-scheme values.
THEME_SCHEME = {":root": "light", ".dark": "dark"}
THEME_MARKER = "brand-foreground"


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


def parse_palette_sha(text: str) -> str:
    lines = sovci.meaningful_lines(text, PALETTE_SHA)
    if len(lines) != 1 or not HEX64.fullmatch(lines[0]):
        raise CIError("%s: expected one line holding a 64-hex sha256" % PALETTE_SHA)
    return lines[0]


def upstream_palette(css: str) -> tuple:
    """(sha256 of the palette text, set of palette variable names) of
    upstream's src/index.css."""
    blocks = [(match.group(2), match.group(3)) for match in PALETTE_BLOCK.finditer(css)]
    text = "\n".join("%s{%s}" % block for block in blocks)
    names = set()
    for _, body in blocks:
        names.update(VARIABLE_NAME.findall(body))
    return hashlib.sha256(text.encode("utf-8")).hexdigest(), frozenset(names)


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

    # 5. Upstream's palette: src/sovtech/theme.css was written against it.
    recorded = parse_palette_sha(load_at_head(PALETTE_SHA, repo))
    digest, names = upstream_palette(load_at_head(UPSTREAM_CSS, repo))
    if digest != recorded:
        rep.fail(
            "upstream-palette-changed",
            "%s :root/.dark digest is now %s; port the change to "
            "src/sovtech/theme.css, then record the digest in %s"
            % (UPSTREAM_CSS, digest, PALETTE_SHA),
        )
    else:
        rep.ok(
            "upstream-palette",
            "%s :root/.dark digest matches (%d variable name(s))" % (UPSTREAM_CSS, len(names)),
        )
    return sovci.EXIT_FINDINGS if rep.failures else sovci.EXIT_OK


def read_file(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


# --- theme order in dist ---
#
# theme.css overrides upstream's palette only by coming later at equal
# specificity. Vite builds one stylesheet per chunk, and a lazy chunk's
# stylesheet loads after the entry's, so upstream palette variables anywhere
# but before theme.css in the entry stylesheet would quietly bring upstream's
# colours back. The check reads the built CSS only; it never runs it.


def mask_css(text: str) -> str:
    """text with comments, string contents, unquoted url() contents and
    backslash escapes blanked to spaces, so every {, } and ; left is
    structural. Offsets are unchanged."""
    out = list(text)
    size = len(text)

    def blank(start: int, end: int) -> None:
        out[start:end] = " " * (end - start)

    i = 0
    while i < size:
        char = text[i]
        if char == "\\":
            blank(i, min(i + 2, size))
            i += 2
        elif char == "/" and text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                raise CIError("unterminated CSS comment")
            blank(i, end + 2)
            i = end + 2
        elif char in "\"'":
            j = i + 1
            while j < size and text[j] != char:
                if text[j] == "\n":
                    raise CIError("unterminated CSS string")
                j += 2 if text[j] == "\\" else 1
            if j >= size:
                raise CIError("unterminated CSS string")
            blank(i + 1, j)
            i = j + 1
        elif (
            char in "uU"
            and text[i : i + 4].lower() == "url("
            and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] in "-_"))
        ):
            j = i + 4
            while j < size and text[j] in " \t\n\r\f":
                j += 1
            if j < size and text[j] in "\"'":
                i = j  # a quoted url() is a string
                continue
            end = text.find(")", j)
            if end < 0:
                raise CIError("unterminated CSS url()")
            blank(j, end)
            i = end + 1
        else:
            i += 1
    return "".join(out)


def css_blocks(masked: str) -> list:
    """[prelude, open, close, parent] for every {...} block of masked CSS, in
    source order; parent is the enclosing block's index or None."""
    blocks, stack, boundary = [], [], 0
    for match in CSS_STRUCTURE.finditer(masked):
        at, char = match.start(), match.group(0)
        if char == "{":
            prelude = " ".join(masked[boundary:at].split())
            blocks.append([prelude, at, -1, stack[-1] if stack else None])
            stack.append(len(blocks) - 1)
        elif char == "}":
            if not stack:
                raise CIError("unbalanced } in CSS")
            blocks[stack.pop()][2] = at
        boundary = at + 1
    if stack:
        raise CIError("unbalanced { in CSS")
    return blocks


def starts_declaration(masked: str, offset: int) -> bool:
    """True when offset begins a declaration: the character before it,
    whitespace skipped, is { or ;. A selector such as Tailwind's
    .shadow-\\[hsl\\(var\\(--ring\\)\\)\\]:hover reads as "--ring   :"
    once its escapes are masked, but never follows { or ;."""
    index = offset - 1
    while index >= 0 and masked[index] in " \t\n\r\f":
        index -= 1
    return index >= 0 and masked[index] in "{;"


def enclosing(blocks: list, opens: list, offset: int) -> int | None:
    """Index of the innermost block holding offset, or None."""
    index = bisect.bisect_left(opens, offset) - 1
    while index >= 0:
        if blocks[index][1] < offset < blocks[index][2]:
            return index
        index -= 1
    return None


def stylesheet_hrefs(html: bytes) -> set:
    """The href of every <link rel="stylesheet"> in an HTML page."""
    hrefs = set()
    for tag in LINK_TAG.finditer(html):
        attributes = {}
        for match in TAG_ATTRIBUTE.finditer(tag.group(1)):
            value = next(v for v in match.groups()[1:] if v is not None)
            attributes.setdefault(match.group(1).lower(), value)
        if b"stylesheet" in attributes.get(b"rel", b"").lower().split() and b"href" in attributes:
            hrefs.add(attributes[b"href"].decode("utf-8", "surrogateescape"))
    return hrefs


def theme_order_findings(files, names: frozenset) -> tuple:
    """([(rule, detail)], summary) for theme.css's place in a built dist.

    files yields (dist-relative path, bytes) for every file in dist; names
    are upstream's palette variable names. Every --brand-* variable counts
    as a palette variable too. Rules:
      theme-css-sentinel  exactly one file declares --brand-foreground: a
                          stylesheet whose theme.css :root and .dark blocks
                          open with color-scheme light and dark;
      theme-css-stray     no other file (lazy chunk stylesheets, inline
                          <style>, scripts) declares a palette variable;
      theme-css-order     every other palette block comes before theme.css's
                          :root block, which is not nested in anything;
      theme-css-selector  every other palette block is exactly :root or
                          .dark (theme.css's specificity), inside at-rules
                          only;
      theme-css-important no other palette block uses !important;
      theme-css-coverage  theme.css's block sets every variable that an
                          upstream block of the same selector sets;
      theme-css-upstream-missing  the check found upstream's :root and .dark
                          palette blocks (else it would order nothing);
      theme-css-unlinked  index.html and 404.html load that stylesheet.
    """

    def is_palette(name: str) -> bool:
        return name in names or name.startswith("brand-")

    findings = []
    declaring, pages, scanned = {}, {}, 0
    for rel, blob in files:
        scanned += 1
        if rel.endswith(".map"):
            raise CIError("source maps must be moved out before the theme order check")
        if rel in ("index.html", "404.html"):
            pages[rel] = blob
        declared = [m.group(1).decode("ascii") for m in DIST_DECLARATION.finditer(blob)]
        if any(is_palette(name) for name in declared):
            declaring[rel] = (declared, blob)
    themed = sorted(rel for rel, (declared, _) in declaring.items() if THEME_MARKER in declared)
    if len(themed) != 1 or not themed[0].endswith(".css"):
        findings.append(
            (
                "theme-css-sentinel",
                "%d file(s) declare --%s; exactly one stylesheet must (theme.css in the entry CSS)"
                % (len(themed), THEME_MARKER),
            )
        )
        return findings, "%d file(s) scanned" % scanned
    theme_rel = themed[0]
    for rel in sorted(declaring):
        if rel != theme_rel:
            count = sum(1 for name in declaring[rel][0] if is_palette(name))
            findings.append(
                (
                    "theme-css-stray",
                    "%s declares %d palette variable(s); only %s may" % (rel, count, theme_rel),
                )
            )

    # Every palette declaration in the theme stylesheet, by enclosing block.
    masked = mask_css(declaring[theme_rel][1].decode("utf-8", "surrogateescape"))
    blocks = css_blocks(masked)
    opens = [block[1] for block in blocks]
    palette = {}  # block index -> [names, uses !important]
    for match in CSS_DECLARATION.finditer(masked):
        name = match.group(1)
        if not is_palette(name) or not starts_declaration(masked, match.start()):
            continue
        index = enclosing(blocks, opens, match.start())
        if index is None:
            findings.append(
                ("theme-css-order", "%s: a palette declaration outside any block" % theme_rel)
            )
            continue
        entry = palette.setdefault(index, [set(), False])
        entry[0].add(name)
        stop = CSS_VALUE_END.search(masked, match.end())
        if IMPORTANT.search(masked[match.end() : stop.start() if stop else len(masked)]):
            entry[1] = True

    theme = {}
    for index, (declared, _) in palette.items():
        if THEME_MARKER in declared:
            theme.setdefault(blocks[index][0], []).append(index)
    if sorted(theme) != sorted(THEME_SCHEME) or any(len(found) != 1 for found in theme.values()):
        findings.append(
            (
                "theme-css-sentinel",
                "%s: expected one :root and one .dark block declaring --%s"
                % (theme_rel, THEME_MARKER),
            )
        )
        return findings, "%d file(s) scanned" % scanned
    root, dark = theme[":root"][0], theme[".dark"][0]
    for selector, index in ((":root", root), (".dark", dark)):
        _, start, end, parent = blocks[index]
        scheme = r"\s*color-scheme\s*:\s*%s\s*(;|$)" % THEME_SCHEME[selector]
        if not re.match(scheme, masked[start + 1 : end]):
            findings.append(
                (
                    "theme-css-sentinel",
                    "%s: theme.css's %s block does not open with color-scheme: %s"
                    % (theme_rel, selector, THEME_SCHEME[selector]),
                )
            )
        if parent is not None:
            findings.append(
                (
                    "theme-css-order",
                    "%s: theme.css's %s block is nested in %s"
                    % (theme_rel, selector, sovci.safe(blocks[parent][0][:60])),
                )
            )
    if blocks[dark][1] < blocks[root][1]:
        findings.append(
            ("theme-css-order", "%s: theme.css's .dark block comes before its :root" % theme_rel)
        )

    upstream = {selector: 0 for selector in THEME_SCHEME}
    for index in sorted(palette):
        if index in (root, dark):
            continue
        declared, important = palette[index]
        prelude, start, _, parent = blocks[index]
        where = "%s: palette block %s at offset %d" % (theme_rel, sovci.safe(prelude[:60]), start)
        if start > blocks[root][1]:
            findings.append(("theme-css-order", where + " comes after theme.css's :root block"))
        if prelude not in THEME_SCHEME:
            findings.append(
                ("theme-css-selector", where + " is not exactly :root or .dark (theme.css's specificity)")
            )
        while parent is not None:
            if not blocks[parent][0].startswith("@"):
                findings.append(("theme-css-selector", where + " is nested in a style rule"))
                break
            parent = blocks[parent][3]
        if important:
            findings.append(("theme-css-important", where + " uses !important"))
        if prelude in THEME_SCHEME:
            upstream[prelude] += 1
            missing = sorted(declared - palette[root if prelude == ":root" else dark][0])
            if missing:
                findings.append(
                    (
                        "theme-css-coverage",
                        where + " sets %d variable(s) theme.css's %s block does not: %s"
                        % (len(missing), prelude, ", ".join("--" + n for n in missing[:8])),
                    )
                )
    for selector, count in upstream.items():
        if not count:
            findings.append(
                (
                    "theme-css-upstream-missing",
                    "%s: no upstream %s palette block, so the order check orders nothing"
                    % (theme_rel, selector),
                )
            )

    href = "/" + theme_rel
    if "index.html" not in pages:
        findings.append(("theme-css-unlinked", "dist has no index.html"))
    for page in sorted(pages):
        if href not in stylesheet_hrefs(pages[page]):
            findings.append(
                ("theme-css-unlinked", "%s does not load %s as a stylesheet" % (page, theme_rel))
            )
    summary = "%s holds theme.css after %d upstream palette block(s); %d file(s) scanned" % (
        theme_rel,
        sum(upstream.values()),
        scanned,
    )
    return findings, summary


def theme_order_self_test() -> int:
    """Positive control: an ordered sample passes, and each planted fault
    fails with its rule. Returns the number of planted faults."""
    names = frozenset({"primary", "background"})
    upstream = ":root{--primary: 1;--background: 2}.dark{--primary: 3;--background: 4}"
    theme = (
        ":root{color-scheme:light;--primary: 5;--background: 6;--brand-500: 7;--brand-foreground: 8}"
        ".dark{color-scheme:dark;--primary: 9;--background: 1;--brand-500: 2;--brand-foreground: 3}"
    )
    # Braces and declarations inside a string, a comment, an escape, an
    # unquoted url() and an escaped Tailwind selector are not structure.
    noise = (
        '.a{content:"}{--primary: 0"}/* :root{--primary: 0} */.b\\{c{color:red}'
        ".d{background:url(x{y}.png)}"
        ".e\\:shadow-\\[hsl\\(var\\(--primary\\)\\)\\]:hover{color:red}"
    )
    page = b'<link rel="stylesheet" crossorigin href="/assets/index-a.css">'
    good = noise + upstream + theme

    def sample(css: str = good, lazy: bytes = b".z{color:blue}", html: bytes = page) -> list:
        return [
            ("index.html", html),
            ("assets/index-a.css", css.encode("ascii")),
            ("assets/lazy-b.css", lazy),
            ("assets/app.js", b"let a=1;"),
        ]

    found, _ = theme_order_findings(sample(), names)
    if found:
        raise CIError("theme order control: the ordered sample failed (%s)" % found[0][0])
    faults = (
        ("reversed", sample(noise + theme + upstream), "theme-css-order"),
        ("layered-theme", sample(noise + upstream + "@layer x{" + theme + "}"), "theme-css-order"),
        ("lazy-chunk", sample(lazy=b":root{--primary: 0}"), "theme-css-stray"),
        ("lazy-brand", sample(lazy=b".x{--brand-500: 0}"), "theme-css-stray"),
        ("inline-style", sample(html=page + b"<style>:root{--background: 0}</style>"), "theme-css-stray"),
        ("specificity", sample(noise + upstream.replace(".dark{", "html.dark{") + theme), "theme-css-selector"),
        ("nested", sample(noise + "html{" + upstream + "}" + theme), "theme-css-selector"),
        ("important", sample(noise + upstream.replace("1;", "1 !important;", 1) + theme), "theme-css-important"),
        ("uncovered", sample(noise + upstream + theme.replace("--background: 1;", "")), "theme-css-coverage"),
        ("no-upstream", sample(noise + theme), "theme-css-upstream-missing"),
        ("unlinked", sample(html=page.replace(b"index-a", b"lazy-b")), "theme-css-unlinked"),
        ("no-theme", sample(noise + upstream), "theme-css-sentinel"),
    )
    for case, files, rule in faults:
        found, _ = theme_order_findings(files, names)
        if rule not in {finding[0] for finding in found}:
            raise CIError("theme order control: the %s sample did not fail %s" % (case, rule))
    return len(faults)


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

    _, names = upstream_palette(load_at_head(UPSTREAM_CSS, repo))
    if not {"primary", "background"} <= names:
        raise CIError("%s declares no --primary or --background palette" % UPSTREAM_CSS)
    faults = theme_order_self_test()
    rep.ok("theme-css-order-control", "the ordered sample passes, %d planted faults fail" % faults)
    files = (
        (os.path.relpath(path, dist).replace(os.sep, "/"), read_file(path))
        for path in sovci.regular_files(dist, "dist")
    )
    found, summary = theme_order_findings(files, names)
    for rule, detail in found:
        rep.fail(rule, detail)
    if not found:
        rep.ok("theme-css-order", summary)
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
