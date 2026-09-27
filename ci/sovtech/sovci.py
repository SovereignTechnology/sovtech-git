"""Shared helpers for the SovTech CI scripts (Python 3 standard library only).

Exit-code contract used by every SovTech CI script:
  0 = checked and clean, 3 = checked and found problems, anything else = the
  check could not run (the gate treats that as a failure too). Exit 1 is never
  used for findings, because an uncaught Python exception also exits 1.

Each script compiles this file from its source into a fresh module, after
its isolation guard (Python 3.10 or later, run as python3 -I): it is never
imported, so no .pyc of it is ever read.
"""

import os
import re
import subprocess
import tempfile

EXIT_OK = 0
EXIT_FINDINGS = 3
EXIT_ERROR = 4

HEX40 = re.compile(r"[0-9a-f]{40}")
UPSTREAM_ROOT = "19dd6a8781c9b3a37d21f4655c94b08791b9d0f4"

# Paths the fork owns outright. The numstat bound ignores them, and no
# upstream commit may add, change or delete them: sync_checks.py deny refuses
# them in BASE..NEW, and gate.sh requires the UPSTREAM_BASE tree to hold none.
FORK_OWNED_PREFIXES = ("src/sovtech/", "ci/sovtech/")
FORK_OWNED_FILES = (
    "SOVTECH.md",
    "NOTICE.md",
    "CHANGELOG.sovtech.md",
    "CLAUDE.md",
    ".gitlab-ci.yml",
    "renovate.json",
)
# The same set as literal git pathspecs (each directory also matches a file or
# symlink of that exact name).
FORK_OWNED_PATHSPECS = tuple(p.rstrip("/") for p in FORK_OWNED_PREFIXES) + FORK_OWNED_FILES

SHADOW_HEADER = [
    "upstream_path",
    "overlay_path",
    "acked_blob",
    "sentinel",
    "upstream_marker",
]
ASSET_SWAP_HEADER = ["path", "fork_blob"]


class CIError(Exception):
    """A check could not run. Callers exit EXIT_ERROR."""


def git(*args: str, repo: str = ".", ok_codes: tuple = (0,)) -> bytes:
    """Run git and return raw stdout. Raises CIError on an unexpected code."""
    proc = subprocess.run(
        ["git", "-C", repo, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode not in ok_codes:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        hint = tail[-1][:300] if tail else "no stderr"
        raise CIError(
            "git %s exited %d (%s)" % (args[0], proc.returncode, hint)
        )
    return proc.stdout


def git_text(*args: str, repo: str = ".", ok_codes: tuple = (0,)) -> str:
    return git(*args, repo=repo, ok_codes=ok_codes).decode(
        "utf-8", "surrogateescape"
    )


def blob_at(rev: str, path: str, repo: str = ".") -> str | None:
    """Object id of path at rev, or None when the path does not exist there."""
    proc = subprocess.run(
        ["git", "-C", repo, "rev-parse", "--verify", "--quiet",
         "%s:%s" % (rev, path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if proc.returncode == 0:
        oid = proc.stdout.decode().strip()
        if not HEX40.fullmatch(oid):
            raise CIError("unexpected object id shape for %s" % path)
        return oid
    if proc.returncode == 1:
        return None
    raise CIError("git rev-parse exited %d for %s" % (proc.returncode, path))


def read_at(rev: str, path: str, repo: str = ".") -> bytes | None:
    """File content at rev, or None when the path does not exist there."""
    oid = blob_at(rev, path, repo)
    if oid is None:
        return None
    kind = git_text("cat-file", "-t", oid, repo=repo).strip()
    if kind != "blob":
        raise CIError("%s at %s is a %s, not a file" % (path, rev[:12], kind))
    return git("cat-file", "blob", oid, repo=repo)


def resolve_commit(rev: str, repo: str = ".") -> str:
    oid = git_text(
        "rev-parse", "--verify", "--quiet", rev + "^{commit}", repo=repo
    ).strip()
    if not HEX40.fullmatch(oid):
        raise CIError("cannot resolve %s to a commit" % rev)
    return oid


def check_repo_path(path: str, source: str) -> None:
    if (
        not path
        or path.startswith("/")
        or path != path.strip()
        or any(part in ("", ".", "..") for part in path.rstrip("/").split("/"))
        or "\t" in path
        or "\r" in path
    ):
        raise CIError("%s: invalid repository path entry" % source)


def meaningful_lines(text: str, source: str) -> list:
    """Lines that are neither blank nor '#' comments, with CRLF refused."""
    if "\r" in text:
        raise CIError("%s: CRLF line endings are not allowed" % source)
    out = []
    for line in text.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        out.append(line)
    return out


def parse_tsv(text: str, header: list, source: str) -> list:
    """Rows of a header-first TSV as dicts. Fails closed on any irregularity."""
    lines = meaningful_lines(text, source)
    if not lines:
        raise CIError("%s: missing header row" % source)
    if lines[0].split("\t") != header:
        raise CIError("%s: header row does not match the expected columns" % source)
    rows = []
    for number, line in enumerate(lines[1:], start=2):
        fields = line.split("\t")
        if len(fields) != len(header):
            raise CIError(
                "%s: data row %d has %d fields, expected %d"
                % (source, number, len(fields), len(header))
            )
        for field in fields:
            if not field or field != field.strip():
                raise CIError(
                    "%s: data row %d has an empty or padded field"
                    % (source, number)
                )
        rows.append(dict(zip(header, fields)))
    return rows


# Glob and pathspec-magic characters: fork-deleted.txt entries are literal.
PATHSPEC_SPECIAL = re.compile(r"[*?\[\\:]")


def parse_fork_deleted(text: str, source: str) -> list:
    """(path, is_dir) entries from fork-deleted.txt."""
    entries = []
    for line in meaningful_lines(text, source):
        check_repo_path(line, source)
        if line.lstrip() != line or " " in line:
            raise CIError("%s: entries must not contain spaces" % source)
        if PATHSPEC_SPECIAL.search(line):
            raise CIError("%s: entries must not contain any of * ? [ \\ :" % source)
        if touches_fork_owned(line.rstrip("/")):
            raise CIError("%s: an entry covers a fork-owned path" % source)
        entries.append((line.rstrip("/"), line.endswith("/")))
    if not entries:
        raise CIError("%s: no entries (the file is required)" % source)
    return entries


def covered_by(path: str, entries: list) -> bool:
    for entry, is_dir in entries:
        if path == entry or (is_dir and path.startswith(entry + "/")):
            return True
    return False


def is_fork_owned(path: str) -> bool:
    return path in FORK_OWNED_FILES or path.startswith(FORK_OWNED_PREFIXES)


def touches_fork_owned(path: str) -> bool:
    """True for a fork-owned path, for a file or symlink named like a fork-owned
    directory (ci/sovtech), and for one standing where a parent directory of a
    fork-owned path must be (ci, src). Case-insensitive, because on a
    case-insensitive checkout CI/Sovtech/x.py lands in ci/sovtech/. This is the
    refusal rule; the numstat exemption (is_fork_owned) stays exact."""
    folded = path.casefold()
    return any(
        folded == spec or folded.startswith(spec + "/") or spec.startswith(folded + "/")
        for spec in (item.casefold() for item in FORK_OWNED_PATHSPECS)
    )


def safe(text: str) -> str:
    """Text fit for a terminal: printable ASCII, newlines and tabs pass; every
    other character (escape sequences, C1 controls, bidi overrides, bytes that
    were not UTF-8) is shown as a backslash escape instead."""
    out = []
    for ch in text:
        code = ord(ch)
        if ch in "\n\t" or 0x20 <= code < 0x7F:
            out.append(ch)
        elif 0xDC80 <= code <= 0xDCFF:  # a surrogateescape'd raw byte
            out.append("\\x%02x" % (code - 0xDC00))
        elif code < 0x100:
            out.append("\\x%02x" % code)
        elif code < 0x10000:
            out.append("\\u%04x" % code)
        else:
            out.append("\\U%08x" % code)
    return "".join(out)


def regular_files(root: str, label: str) -> list:
    """Every file under root, sorted. Fails on ANY symlink, to a file or to a
    directory (os.walk lists a linked directory but never enters it, so its
    files would go unscanned), on anything that is not a regular file, and on
    a directory it cannot read (os.walk skips those silently by default)."""
    if not os.path.isdir(root) or os.path.islink(root):
        raise CIError("%s directory is missing" % label)

    def unreadable(exc: OSError) -> None:
        raise CIError("%s: a directory could not be read (%s)" % (label, exc.strerror or "error"))

    def shown(path: str) -> str:
        return os.path.join(label, os.path.relpath(path, root))

    files = []
    for base, dirs, names in os.walk(root, followlinks=False, onerror=unreadable):
        dirs.sort()
        for name in dirs:
            path = os.path.join(base, name)
            if os.path.islink(path):
                raise CIError("%s is a symlink to a directory" % shown(path))
        for name in sorted(names):
            path = os.path.join(base, name)
            if os.path.islink(path):
                raise CIError("%s is a symlink" % shown(path))
            if not os.path.isfile(path):
                raise CIError("%s is not a regular file" % shown(path))
            files.append(path)
    return files


def regular_files_self_test() -> None:
    """Positive control for regular_files: a plain tree lists every file, and
    a symlinked file or directory anywhere in it fails."""
    with tempfile.TemporaryDirectory(prefix="sovci-walk-") as tmp:
        plain = os.path.join(tmp, "plain")
        os.makedirs(os.path.join(plain, "a", "b"))
        for rel in ("top.txt", os.path.join("a", "b", "deep.txt")):
            with open(os.path.join(plain, rel), "wb") as handle:
                handle.write(b"x")
        if len(regular_files(plain, "control")) != 2:
            raise CIError("self-test: the walker did not list a plain tree exactly")
        outside = os.path.join(tmp, "outside")
        os.makedirs(outside)
        with open(os.path.join(outside, "hidden.txt"), "wb") as handle:
            handle.write(b"x")
        cases = (
            ("linked-dir", os.path.join("a", "linked"), outside),
            ("linked-file", os.path.join("a", "b", "linked.txt"), os.path.join(outside, "hidden.txt")),
        )
        for case, rel, target in cases:
            link = os.path.join(plain, rel)
            os.symlink(target, link)
            try:
                regular_files(plain, "control")
            except CIError:
                pass
            else:
                raise CIError("self-test: the walker accepted a %s" % case)
            os.unlink(link)


CSP_META = re.compile(
    rb"<meta\b[^>]*?http-equiv\s*=\s*[\"']content-security-policy[\"'][^>]*>",
    re.IGNORECASE | re.DOTALL,
)


def csp_meta_elements(html: bytes) -> list:
    """Every CSP <meta> element in an HTML document, byte for byte."""
    return CSP_META.findall(html)
