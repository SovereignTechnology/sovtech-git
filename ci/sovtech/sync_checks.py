#!/usr/bin/env -S python3 -I
"""Checks and reports for ci/sovtech/sync-upstream.sh (stdlib only).

  refs      print the object id of one ref from a saved smart-HTTP
            info/refs advertisement (git-upload-pack, protocol v0/v1)
  deny      refuse any upstream change to a fork-owned path, and agent-config
            deny-by-default, over the upstream diff BASE..NEW
  owned     after a sync merge: no fork-owned path differs between the fork
            head (--base) and the merge (--new)
  security  list changed security-sensitive upstream paths for review
  drift     the drift report: shadowed files, watched files, new-file triage
  print     print a captured output file (git merge's, which names upstream
            paths) through sovci.safe()

Every upstream-controlled path and diff line is printed through sovci.safe(),
so no escape sequence from upstream reaches the terminal. Diffs run with
--no-ext-diff --no-textconv: no configured diff program sees upstream bytes.

Exit codes: see sovci.py (deny exits 3 when a path is refused).
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
import fnmatch
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

AGENT_DIRS = {".claude", ".agents", ".opencode", ".cursor", ".gemini", ".vscode", ".github", ".gitlab"}
# No external diff driver or textconv filter ever runs on upstream content.
DIFF = ("diff", "--no-ext-diff", "--no-textconv", "--no-color")
SECURITY_EXACT = {
    "src/services/nostr.ts",
    "src/services/accounts.ts",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "index.html",
}


def name_status(base: str, new: str, repo: str) -> list:
    raw = sovci.git(
        *DIFF, "--no-renames", "--name-status", "-z", base, new, repo=repo
    ).decode("utf-8", "surrogateescape")
    tokens = raw.split("\0")
    if tokens and tokens[-1] == "":
        tokens.pop()
    if len(tokens) % 2:
        raise CIError("unexpected git diff --name-status output")
    return [(tokens[i], tokens[i + 1]) for i in range(0, len(tokens), 2)]


def numstat(base: str, new: str, path: str, repo: str) -> str:
    out = sovci.git_text(*DIFF, "--no-renames", "--numstat", base, new, "--", path, repo=repo)
    parts = out.split("\t")
    return "+%s -%s" % (parts[0], parts[1]) if len(parts) >= 3 else "+? -?"


# --- refs ---


def cmd_refs(args: argparse.Namespace) -> int:
    with open(args.file, "rb") as handle:
        data = handle.read()
    pos, lines = 0, []
    while pos < len(data):
        head = data[pos : pos + 4]
        if len(head) != 4 or not re.fullmatch(rb"[0-9a-f]{4}", head):
            raise CIError("not a pkt-line advertisement")
        size = int(head, 16)
        if size == 0:
            lines.append(None)
            pos += 4
            continue
        if size < 4 or pos + size > len(data):
            raise CIError("truncated pkt-line")
        lines.append(data[pos + 4 : pos + size].rstrip(b"\n"))
        pos += size
    if not lines or lines[0] != b"# service=git-upload-pack":
        raise CIError("not a smart-HTTP git-upload-pack advertisement")
    want = args.ref.encode()
    found = []
    for line in lines[1:]:
        if line is None:
            continue
        line = line.split(b"\0", 1)[0]
        parts = line.split(b" ")
        if len(parts) == 2 and parts[1] == want:
            found.append(parts[0].decode("ascii", "replace"))
    if len(found) != 1 or not sovci.HEX40.fullmatch(found[0]):
        raise CIError("%s appears %d time(s) in the advertisement" % (args.ref, len(found)))
    print(found[0])
    return sovci.EXIT_OK


# --- deny ---


def load_allow(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    allow = {}
    for line in sovci.meaningful_lines(text, path):
        parts = line.split()
        if len(parts) != 2 or not sovci.HEX40.fullmatch(parts[1]):
            raise CIError("%s: entries are '<path> <acked 40-hex blob>'" % path)
        sovci.check_repo_path(parts[0], path)
        allow[parts[0]] = parts[1]
    return allow


def agent_rule(status: str, path: str) -> str | None:
    """Why a path counts as agent/editor config, or None."""
    parts = path.split("/")
    base = parts[-1]
    if any(part in AGENT_DIRS for part in parts[:-1]):
        return "agent-config-dir"
    if fnmatch.fnmatch(base.lower(), "*mcp*.json"):
        return "mcp-config"
    if base in ("opencode.json", "opencode.jsonc"):
        return "opencode-config"
    if base == "CLAUDE.md":
        return "claude-md"
    if base == "AGENTS.md":
        return "agents-md-new" if status == "A" else "agents-md-review"
    return None


def cmd_deny(args: argparse.Namespace) -> int:
    repo = args.repo
    deleted_text = sovci.read_at(args.rules_rev, "ci/sovtech/fork-deleted.txt", repo)
    if deleted_text is None:
        raise CIError("fork-deleted.txt is missing at %s" % args.rules_rev)
    deleted = sovci.parse_fork_deleted(deleted_text.decode("utf-8"), "fork-deleted.txt")
    allow = load_allow(args.allowlist)
    refused = review = owned = 0
    for status, path in name_status(args.base, args.new, repo):
        shown = sovci.safe(path)
        # Fork-owned paths first, for every status and with no allowlist: an
        # upstream file there (ci/sovtech/argparse.py, a new gate.sh) would
        # run on the laptop or in the gate as the fork's own code.
        if sovci.touches_fork_owned(path):
            refused += 1
            owned += 1
            print("FAIL fork-owned: %s %s (upstream must never touch fork-owned paths)"
                  % (status, shown))
            continue
        if status[0] not in "AMTC":
            continue
        rule = agent_rule(status[0], path)
        if rule is None:
            continue
        if sovci.covered_by(path, deleted):
            print("info %s: %s %s (fork-deleted, the sync removes it)" % (rule, status, shown))
            continue
        if rule == "agents-md-review":
            review += 1
            print(
                "HUMAN REVIEW agents-md: %s changed (%s); read the diff before merging"
                % (shown, numstat(args.base, args.new, path, repo))
            )
            continue
        new_blob = sovci.blob_at(args.new, path, repo)
        if new_blob is not None and allow.get(path) == new_blob:
            print("info %s: %s %s (acked in agent-config-allow.txt)" % (rule, status, shown))
            continue
        refused += 1
        print("FAIL %s: %s %s" % (rule, status, shown))
        if new_blob is not None:
            print("       ack after review with: %s %s" % (shown, new_blob))
    print("deny: %d refused (%d fork-owned), %d for human review" % (refused, owned, review))
    return sovci.EXIT_FINDINGS if refused else sovci.EXIT_OK


# --- owned ---


def cmd_owned(args: argparse.Namespace) -> int:
    changed = [
        (status, path)
        for status, path in name_status(args.base, args.new, args.repo)
        if sovci.touches_fork_owned(path)
    ]
    for status, path in changed:
        print("FAIL owned: %s %s differs from the fork head" % (status, sovci.safe(path)))
    if changed:
        return sovci.EXIT_FINDINGS
    print("ok   owned: every fork-owned path equals the fork head's")
    return sovci.EXIT_OK


# --- security ---


def cmd_security(args: argparse.Namespace) -> int:
    hits = 0
    for status, path in name_status(args.base, args.new, args.repo):
        lower = path.lower()
        if (
            path in SECURITY_EXACT
            or path.startswith("patches/")
            or "signer" in lower
            or "/nip46" in lower
            or "bunker" in lower
        ):
            hits += 1
            print(
                "review security: %s %s (%s)"
                % (status, sovci.safe(path), numstat(args.base, args.new, path, args.repo))
            )
    print("security: %d path(s) to review" % hits)
    return sovci.EXIT_OK


# --- print ---


def cmd_print(args: argparse.Namespace) -> int:
    with open(args.file, "rb") as handle:
        text = handle.read().decode("utf-8", "surrogateescape").rstrip("\n")
    # Newlines and tabs pass; safe() shows ESC, CR, any other control and
    # U+2028 as an escape, so none can restyle, rewrite or end a line.
    if text:
        print(sovci.safe(text))
    return sovci.EXIT_OK


# --- drift ---


def css_block(text: str, selector: str) -> str | None:
    match = re.search(r"(?m)^[ \t]*" + re.escape(selector) + r"\s*\{", text)
    if match is None:
        return None
    depth, start = 0, match.start()
    for i in range(match.end() - 1, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def text_at(rev: str, path: str, repo: str) -> str:
    data = sovci.read_at(rev, path, repo)
    return "" if data is None else data.decode("utf-8", "replace")


def show_diff(base: str, new: str, path: str, repo: str) -> None:
    out = sovci.git_text(*DIFF, "--stat", base, new, "--", path, repo=repo)
    print(sovci.safe(out.rstrip()) or "  (no change)")
    print(sovci.safe(sovci.git_text(*DIFF, base, new, "--", path, repo=repo).rstrip()))


def cmd_drift(args: argparse.Namespace) -> int:
    repo, base, new = args.repo, args.base, args.new
    count = sovci.git_text("rev-list", "--count", "%s..%s" % (base, new), repo=repo).strip()
    changes = name_status(base, new, repo)
    print("== drift: %s..%s, %s commit(s), %d path(s) changed" % (base[:12], new[:12], count, len(changes)))

    print("\n== drift: shadowed files")
    shadow = sovci.read_at(args.rules_rev, "ci/sovtech/shadow-map.tsv", repo)
    if shadow is None:
        raise CIError("shadow-map.tsv is missing at %s" % args.rules_rev)
    rows = sovci.parse_tsv(shadow.decode("utf-8"), sovci.SHADOW_HEADER, "shadow-map.tsv")
    for row in rows:
        path, acked = row["upstream_path"], row["acked_blob"]
        now = sovci.blob_at(new, path, repo)
        shown = sovci.safe(path)
        if now is None:
            print("DRIFT shadow: %s was deleted or moved upstream" % shown)
        elif now == acked:
            print("ok    shadow: %s unchanged" % shown)
        else:
            print("DRIFT shadow: %s changed; port it into %s, then set acked_blob %s"
                  % (shown, sovci.safe(row["overlay_path"]), now))
            print(sovci.safe(sovci.git_text(*DIFF, acked, now, repo=repo).rstrip()))
    if not rows:
        print("info  shadow: no shadowed files yet")

    print("\n== drift: watched files")
    old_css, new_css = text_at(base, "src/index.css", repo), text_at(new, "src/index.css", repo)
    for selector in (":root", ".dark"):
        a, b = css_block(old_css, selector), css_block(new_css, selector)
        digest = lambda s: hashlib.sha256(s.encode()).hexdigest()[:16] if s else "missing"
        state = "ok   " if a == b and a is not None else "DRIFT"
        print("%s palette %s block: %s -> %s" % (state, selector, digest(a), digest(b)))
    if css_block(old_css, ":root") != css_block(new_css, ":root") or css_block(
        old_css, ".dark"
    ) != css_block(new_css, ".dark"):
        show_diff(base, new, "src/index.css", repo)

    old_csp = sovci.csp_meta_elements(text_at(base, "index.html", repo).encode())
    new_csp = sovci.csp_meta_elements(text_at(new, "index.html", repo).encode())
    if old_csp == new_csp and len(new_csp) == 1:
        print("ok    index.html CSP meta unchanged")
    else:
        print("DRIFT index.html CSP meta changed (the gate compares dist against it)")
        show_diff(base, new, "index.html", repo)

    def verify_lines(rev: str) -> list:
        return [ln.strip() for ln in text_at(rev, "src/services/nostr.ts", repo).splitlines()
                if "verifyEvent" in ln]

    if verify_lines(base) == verify_lines(new):
        print("ok    src/services/nostr.ts verifyEvent lines unchanged (accepted-risk watch)")
    else:
        print("DRIFT src/services/nostr.ts verifyEvent lines changed (accepted-risk watch):")
        for label, rev in (("before", base), ("after", new)):
            for line in verify_lines(rev):
                print("  %s: %s" % (label, sovci.safe(line[:200])))

    for path, why in (
        ("netlify.toml", "upstream security headers; mirror into l5400 nginx"),
        (".ngit/act/workflows/ci.yml", "upstream CI; a signal that the gate may need updating"),
    ):
        if any(p == path for _, p in changes):
            print("DRIFT %s changed (%s):" % (path, why))
            show_diff(base, new, path, repo)
        else:
            print("ok    %s unchanged" % path)

    print("\n== drift: new-file triage")
    for status, path in changes:
        shown = sovci.safe(path)
        if status == "A":
            print("new   %s" % shown)
        if any(part.startswith(".") for part in path.split("/")) and status[0] in "AMTC":
            print("dot   %s %s" % (status, shown))
        if path in ("package.json", "pnpm-lock.yaml", "package-lock.json") or path.startswith("patches/"):
            print("deps  %s %s" % (status, shown))
    added = sovci.git_text(*DIFF, "-U0", base, new, "--", ".",
                           ":(exclude)pnpm-lock.yaml", ":(exclude)package-lock.json", repo=repo)
    hosts_rx = re.compile(r"\b(?:wss|https)://([A-Za-z0-9.-]+)")
    known_raw = sovci.git_text("grep", "--no-textconv", "-I", "-h", "-o", "-E", r"(wss|https)://[A-Za-z0-9.-]+",
                               base, "--", ".", ":(exclude)pnpm-lock.yaml",
                               ":(exclude)package-lock.json", repo=repo, ok_codes=(0, 1))
    known = set(hosts_rx.findall(known_raw))
    new_hosts, sites, current = {}, {}, None
    for line in added.splitlines():
        if line.startswith("+++ "):
            current = line[6:] if line.startswith("+++ b/") else None
            continue
        if not line.startswith("+") or current is None:
            continue
        for host in hosts_rx.findall(line):
            if host not in known:
                new_hosts[host] = new_hosts.get(host, 0) + 1
        if current.startswith("src/") and re.search(r"\bfetch\(|\bWebSocket\(", line):
            sites[current] = sites.get(current, 0) + 1
    for host, n in sorted(new_hosts.items()):
        print("host  new literal host %s (%d added line(s))" % (sovci.safe(host), n))
    for path, n in sorted(sites.items()):
        print("net   %s: %d added fetch(/WebSocket( line(s)" % (sovci.safe(path), n))
    print("\n== drift: end of report")
    return sovci.EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("refs")
    p.add_argument("--file", required=True)
    p.add_argument("--ref", default="refs/heads/main")
    p = sub.add_parser("print")
    p.add_argument("--file", required=True)
    for name in ("deny", "owned", "security", "drift"):
        p = sub.add_parser(name)
        p.add_argument("--repo", default=".")
        p.add_argument("--base", required=True)
        p.add_argument("--new", required=True)
        if name in ("deny", "drift"):
            p.add_argument("--rules-rev", required=True,
                           help="fork revision whose ci/sovtech rules apply")
        if name == "deny":
            p.add_argument("--allowlist", required=True)
    args = parser.parse_args()
    handlers = {"refs": cmd_refs, "deny": cmd_deny, "owned": cmd_owned,
                "security": cmd_security, "drift": cmd_drift, "print": cmd_print}
    try:
        for attr in ("base", "new"):
            value = getattr(args, attr, None)
            if value is not None and not sovci.HEX40.fullmatch(value):
                raise CIError("--%s must be a 40-hex commit id" % attr)
        return handlers[args.command](args)
    except (CIError, OSError, UnicodeDecodeError) as exc:
        print("ERROR sync-checks %s: %s" % (args.command, sovci.safe(str(exc))))
        return sovci.EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
