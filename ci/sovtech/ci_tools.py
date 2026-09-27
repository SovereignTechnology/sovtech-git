#!/usr/bin/env -S python3 -I
"""Small SovTech CI helpers (Python 3 standard library only).

  gitleaks-report  read a gitleaks JSON report: RuleID, File, StartLine and
                   Commit only (the Secret and Match fields are never read);
                   --expect-count N makes it a positive control,
                   --expect-commit SHA also requires every finding from SHA,
                   and --expect-file PATH (repeated) requires the findings'
                   files to be exactly those paths, one finding each
  junit-check      fail unless a JUnit file has >= 1 testcase, no <skipped,
                   no failures and no errors
  move-maps        move every *.map out of dist into a separate directory
  build-info       write build-info.json for a release artifact

Exit codes: see sovci.py.
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
import json
import os
import re
import types
import xml.etree.ElementTree as ET


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

GITLEAKS_FINDINGS_RC = 3


def cmd_gitleaks_report(args: argparse.Namespace) -> int:
    if args.rc not in (0, GITLEAKS_FINDINGS_RC):
        raise CIError("gitleaks exited %d (an error, not a result)" % args.rc)
    if not os.path.isfile(args.report):
        raise CIError("gitleaks wrote no report")
    with open(args.report, "rb") as handle:
        doc = json.loads(handle.read().decode("utf-8"))
    if not isinstance(doc, list):
        raise CIError("gitleaks report is not a JSON list")
    if (args.rc == 0) != (len(doc) == 0):
        raise CIError("gitleaks exit code and report disagree")
    for item in doc:
        if not isinstance(item, dict):
            raise CIError("gitleaks report entry is not an object")
        rule = str(item.get("RuleID", "?"))
        path = str(item.get("File", "?"))
        line = item.get("StartLine", "?")
        commit = str(item.get("Commit", ""))[:12] or "worktree"
        if re.search(r"[^\x20-\x7e]", rule + path):
            rule, path = "(non-printable)", "(non-printable)"
        print("%s %s: %s:%s commit %s" % (args.label, rule, path, line, commit))
    if (args.expect_commit is not None or args.expect_file) and args.expect_count is None:
        raise CIError("--expect-commit and --expect-file need --expect-count")
    if args.expect_count is not None:
        if args.expect_count < 1:
            raise CIError("--expect-count must be at least 1")
        if args.expect_commit is not None:
            if not sovci.HEX40.fullmatch(args.expect_commit):
                raise CIError("--expect-commit must be a 40-hex commit id")
            if any(str(item.get("Commit", "")) != args.expect_commit for item in doc):
                raise CIError("positive control: a finding is not from the expected commit")
        if args.expect_file:
            if len(args.expect_file) != args.expect_count:
                raise CIError("--expect-file must be given once per expected finding")
            if sorted(str(item.get("File", "")) for item in doc) != sorted(args.expect_file):
                raise CIError("positive control: the findings are not one in each expected file")
        if len(doc) != args.expect_count:
            raise CIError(
                "positive control: gitleaks reported %d finding(s), expected exactly %d"
                % (len(doc), args.expect_count)
            )
        print("ok   gitleaks-control: exactly %d finding(s) on the planted sample" % len(doc))
        return sovci.EXIT_OK
    if doc:
        print("gitleaks: %d finding(s)" % len(doc))
        return sovci.EXIT_FINDINGS
    print("ok   gitleaks: no findings")
    return sovci.EXIT_OK


def cmd_junit_check(args: argparse.Namespace) -> int:
    path = args.file
    if not os.path.isfile(path) or os.path.islink(path):
        raise CIError("JUnit report is missing")
    if os.path.getsize(path) == 0:
        raise CIError("JUnit report is empty")
    with open(path, "rb") as handle:
        raw = handle.read()
    if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        raise CIError("JUnit report carries a DTD")
    root = ET.fromstring(raw)
    cases = list(root.iter("testcase"))
    skipped = raw.count(b"<skipped")
    failures = sum(1 for _ in root.iter("failure"))
    errors = sum(1 for _ in root.iter("error"))
    print(
        "junit: testcases=%d skipped=%d failures=%d errors=%d"
        % (len(cases), skipped, failures, errors)
    )
    if not cases or skipped or failures or errors:
        print("FAIL junit-check: e2e must run every test, and every test must pass")
        return sovci.EXIT_FINDINGS
    return sovci.EXIT_OK


def cmd_move_maps(args: argparse.Namespace) -> int:
    dist, out = args.dist, args.out
    if not os.path.isdir(dist) or os.path.islink(dist):
        raise CIError("dist directory is missing")
    if os.path.lexists(out) and (not os.path.isdir(out) or os.listdir(out)):
        raise CIError("maps directory already exists and is not empty")
    moved = 0
    for root, dirs, names in os.walk(dist):
        dirs.sort()
        for name in sorted(names):
            if not name.endswith(".map"):
                continue
            src = os.path.join(root, name)
            if os.path.islink(src) or not os.path.isfile(src):
                raise CIError("a .map entry is not a regular file")
            dest = os.path.join(out, os.path.relpath(src, dist))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            os.replace(src, dest)
            moved += 1
    os.makedirs(out, exist_ok=True)
    print("move-maps: %d source map(s) moved out of dist" % moved)
    return sovci.EXIT_OK


def cmd_build_info(args: argparse.Namespace) -> int:
    for name, value in (("commit", args.commit), ("upstream-base", args.upstream_base)):
        if not sovci.HEX40.fullmatch(value):
            raise CIError("--%s must be a 40-hex commit id" % name)
    if not re.fullmatch(r"v24\.\d+\.\d+", args.node):
        raise CIError("--node must be a v24.x.y version")
    if args.pnpm != "9.15.9":
        raise CIError("--pnpm must be 9.15.9")
    if not re.fullmatch(r"sovtech-v[0-9A-Za-z.+-]+", args.tag):
        raise CIError("--tag must be a sovtech-v* tag")
    if not args.pipeline_id.isdigit() or not args.source_date_epoch.isdigit():
        raise CIError("--pipeline-id and --source-date-epoch must be integers")
    info = {
        "name": "sovtech-git",
        "tag": args.tag,
        "commit": args.commit,
        "upstream_base": args.upstream_base,
        "node": args.node,
        "pnpm": args.pnpm,
        "pipeline_id": int(args.pipeline_id),
        "source_date_epoch": int(args.source_date_epoch),
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(info, indent=2, sort_keys=True) + "\n")
    print("build-info: wrote %s for %s" % (os.path.basename(args.out), args.commit[:12]))
    return sovci.EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("gitleaks-report")
    p.add_argument("--report", required=True)
    p.add_argument("--rc", type=int, required=True)
    p.add_argument("--label", default="FAIL gitleaks")
    p.add_argument("--expect-count", type=int, default=None,
                   help="positive control: require exactly N findings")
    p.add_argument("--expect-commit", default=None,
                   help="positive control: every finding must come from this commit")
    p.add_argument("--expect-file", action="append", default=[],
                   help="positive control: one finding in this file (repeat per file)")
    p = sub.add_parser("junit-check")
    p.add_argument("--file", required=True)
    p = sub.add_parser("move-maps")
    p.add_argument("--dist", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("build-info")
    for flag in ("--out", "--tag", "--commit", "--upstream-base", "--node",
                 "--pnpm", "--pipeline-id", "--source-date-epoch"):
        p.add_argument(flag, required=True)
    args = parser.parse_args()
    handlers = {
        "gitleaks-report": cmd_gitleaks_report,
        "junit-check": cmd_junit_check,
        "move-maps": cmd_move_maps,
        "build-info": cmd_build_info,
    }
    try:
        return handlers[args.command](args)
    except (CIError, OSError, ValueError, ET.ParseError) as exc:
        print("ERROR %s: %s" % (args.command, sovci.safe(str(exc))))
        return sovci.EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
