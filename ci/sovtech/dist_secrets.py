#!/usr/bin/env -S python3 -I
"""Secret-shape scan over a built dist, source maps INCLUDED (stdlib only).

Before scanning anything it runs a positive control: a synthetic sample built
in memory (no secret-shaped literal exists in this file) must make every rule
fire exactly once, and a clean sample must make none fire. If the control does
not behave, the scan refuses to run.

Findings are reported as rule id, relative file and byte offset. No matched
substring is ever printed. Exit codes: see sovci.py.
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
import os
import re
import string
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

B32 = rb"[02-9ac-hj-np-z]"
RULES = [
    ("nostr-nsec", re.compile(rb"nsec1" + B32 + rb"{58}")),
    ("nostr-ncryptsec", re.compile(rb"ncryptsec1" + B32 + rb"{90,}")),
    ("nostr-nbunksec", re.compile(rb"nbunksec1" + B32 + rb"{40,}")),
    ("nip46-bunker-secret", re.compile(rb"bunker://[0-9a-f]{64}\?[^\"' ]*secret=")),
    ("gitlab-pat", re.compile(rb"glpat-[A-Za-z0-9_-]{20}")),
    ("github-token", re.compile(rb"gh[pousr]_[A-Za-z0-9]{36}")),
    ("github-fine-grained-pat", re.compile(rb"github_pat_")),
    ("private-key-block", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("aws-access-key-id", re.compile(rb"AKIA[0-9A-Z]{16}")),
]


def _cycle(alphabet: str, n: int, step: int) -> str:
    return "".join(alphabet[(i * step) % len(alphabet)] for i in range(n))


def synthetic_samples() -> dict:
    """One shape-valid, meaningless sample per rule, assembled at run time."""
    b32 = "023456789acdefghjklmnpqrstuvwxyz"
    alnum = string.ascii_letters + string.digits
    upper = string.ascii_uppercase + string.digits
    join = "".join
    return {
        "nostr-nsec": join(["n", "sec", "1", _cycle(b32, 58, 7)]),
        "nostr-ncryptsec": join(["ncrypt", "sec", "1", _cycle(b32, 96, 5)]),
        "nostr-nbunksec": join(["nbunk", "sec", "1", _cycle(b32, 48, 3)]),
        "nip46-bunker-secret": join(
            ["bun", "ker://", "ab" * 32, "?relay=wss://r.invalid&", "sec", "ret=", "x"]
        ),
        "gitlab-pat": join(["gl", "pat-", _cycle(alnum, 20, 11)]),
        "github-token": join(["gh", "s_", _cycle(alnum, 36, 13)]),
        "github-fine-grained-pat": join(["github", "_pat_", _cycle(alnum, 22, 17)]),
        "private-key-block": join(["-----BEGIN ", "EC PRIV", "ATE KEY-----"]),
        "aws-access-key-id": join(["AK", "IA", _cycle(upper, 16, 7)]),
    }


def scan_blob(blob: bytes) -> list:
    """(rule id, byte offset) for every match."""
    hits = []
    for rule, rx in RULES:
        for match in rx.finditer(blob):
            hits.append((rule, match.start()))
    return hits


def self_test() -> None:
    sovci.regular_files_self_test()
    samples = synthetic_samples()
    if set(samples) != {rule for rule, _ in RULES}:
        raise CIError("self-test: a rule has no synthetic sample")
    for rule, sample in samples.items():
        fired = [r for r, _ in scan_blob(sample.encode())]
        if fired != [rule]:
            raise CIError("self-test: rule %s did not fire alone on its sample" % rule)
    combined = "\n".join(samples.values()).encode()
    if len(scan_blob(combined)) != len(RULES):
        raise CIError("self-test: combined sample did not fire every rule once")
    clean = join_clean()
    if scan_blob(clean):
        raise CIError("self-test: a rule fired on the clean sample")


def join_clean() -> bytes:
    # Near misses: too short, wrong prefix, public key, END line only.
    return b"\n".join(
        [
            b"npub1" + b"q" * 58,
            b"nsec1" + b"q" * 57,
            b"bunker://" + b"ab" * 32 + b"?relay=wss://r.invalid",
            b"glpat-short",
            b"ghx_" + b"a" * 36,
            b"-----END PUBLIC KEY-----",
            b"AKIA" + b"a" * 16,
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dist", required=True)
    parser.add_argument("--maps", help="directory the source maps were moved to")
    parser.add_argument("--min-files", type=int, default=10)
    parser.add_argument("--self-test-only", action="store_true")
    args = parser.parse_args()
    try:
        self_test()
        print("ok   secret-self-test: %d rule(s) fired on the synthetic sample; "
              "a symlink in a tree fails the walk" % len(RULES))
        if args.self_test_only:
            return sovci.EXIT_OK
        targets = [(args.dist, "dist")]
        if args.maps:
            targets.append((args.maps, "maps"))
        findings, scanned = [], {}
        for root, label in targets:
            # Fails on any symlink, to a file or to a directory.
            files = sovci.regular_files(root, label)
            scanned[label] = len(files)
            for path in files:
                with open(path, "rb") as handle:
                    blob = handle.read()
                rel = os.path.join(label, os.path.relpath(path, root))
                findings.extend((rule, rel, off) for rule, off in scan_blob(blob))
        if scanned["dist"] < args.min_files:
            raise CIError("dist has %d file(s), floor is %d" % (scanned["dist"], args.min_files))
    except (CIError, OSError) as exc:
        print("ERROR dist-secrets: %s" % sovci.safe(str(exc)))
        return sovci.EXIT_ERROR

    print(
        "dist-secrets: scanned %s"
        % ", ".join("%s=%d file(s)" % item for item in sorted(scanned.items()))
    )
    for rule, rel, offset in findings:
        print("FAIL %s: %s @ byte %d" % (rule, sovci.safe(rel), offset))
    if findings:
        print("dist-secrets: %d finding(s)" % len(findings))
        return sovci.EXIT_FINDINGS
    print("ok   dist-secrets: no secret-shaped strings")
    return sovci.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
