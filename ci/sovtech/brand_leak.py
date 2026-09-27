#!/usr/bin/env -S python3 -I
"""Brand-leak ratchet over a built dist (Python 3 standard library only).

Counts upstream brand and identity residue in dist, with source maps already
moved out, and compares every count with ci/sovtech/brand-allowlist.json:

  functional  permanent residue with a reason (host sets, attribution);
  pending     residue a named MR will remove, with its exact count.

A term's observed count must equal the sum of its allowlisted counts EXACTLY.
A drop is a failure too: delete or lower the entry in the MR that clears it.

Modes: default (compare), --release (pending must also be empty), --baseline
(report-only: print counts and a pending section to seed, exit 0).

Output is term ids, relative paths and counts only. Exit codes: see sovci.py.
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

DAN_NPUB = "npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr"
DAN_HEX = "a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d"
EXPECTED_OG_URL = "https://git.sovtech.pro/"

# gitworkshop-host counts every mention of the host, in any case, with or
# without a scheme (so URLs count under both url and host): visible strings
# such as the footer's "gitworkshop.dev" carry no scheme, and the
# case-sensitive word term does not see them.
TEXT_TERMS = [
    ("gitworkshop-word", re.compile(rb"\bGitWorkshop\b")),
    ("gitworkshop-url", re.compile(rb"https?://(?:www\.)?gitworkshop\.dev")),
    (
        "gitworkshop-host",
        re.compile(rb"(?i)(?<![A-Za-z0-9-])gitworkshop\.dev(?![A-Za-z0-9-])"),
    ),
    ("danconwaydev", re.compile(rb"(?i)danconwaydev")),
    ("nos-lol", re.compile(rb"(?<![A-Za-z0-9-])nos\.lol(?![A-Za-z0-9-])")),
    ("dan-npub", re.compile(re.escape(DAN_NPUB.encode()))),
    (
        "dan-hex",
        re.compile(rb"(?i)(?<![0-9a-f])" + DAN_HEX.encode() + rb"(?![0-9a-f])"),
    ),
]
STRUCT_TERMS = ["dan-bech32-tlv", "manifest-name", "og-url"]
ALL_TERMS = [name for name, _ in TEXT_TERMS] + STRUCT_TERMS

BECH32_TOKEN = re.compile(
    rb"(?i)(?<![0-9a-z])(npub1|nprofile1|naddr1|nevent1|note1)[02-9ac-hj-np-z]{6,}"
)
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
BECH32_CONST = 1
BECH32M_CONST = 0x2BC830A3

OG_URL = re.compile(
    rb"<meta\b[^>]*?property\s*=\s*[\"']og:url[\"'][^>]*>", re.IGNORECASE | re.DOTALL
)
CONTENT_ATTR = re.compile(rb"\bcontent\s*=\s*\"([^\"]*)\"", re.IGNORECASE)


# --- bech32 (BIP-173), without the 90-character limit NIP-19 TLVs exceed ---


def _polymod(values: list) -> int:
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ value
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp: str) -> list:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _convertbits(data: list, frombits: int, tobits: int, pad: bool) -> list | None:
    acc, bits, out, maxv = 0, 0, [], (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            out.append((acc >> bits) & maxv)
    if pad:
        if bits:
            out.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return out


def bech32_decode(token: str) -> tuple | None:
    """(hrp, payload bytes) for a valid bech32/bech32m string, else None."""
    token = token.lower()
    pos = token.rfind("1")
    if pos < 1 or pos + 7 > len(token):
        return None
    hrp, data = token[:pos], token[pos + 1 :]
    if any(c not in CHARSET for c in data):
        return None
    values = [CHARSET.find(c) for c in data]
    if _polymod(_hrp_expand(hrp) + values) not in (BECH32_CONST, BECH32M_CONST):
        return None
    payload = _convertbits(values[:-6], 5, 8, False)
    if payload is None:
        return None
    return hrp, bytes(payload)


def bech32_encode(hrp: str, payload: bytes) -> str:
    values = _convertbits(list(payload), 8, 5, True) or []
    poly = _polymod(_hrp_expand(hrp) + values + [0] * 6) ^ BECH32_CONST
    checksum = [(poly >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[v] for v in values + checksum)


# --- counting ---


def count_text(blob: bytes, key: bytes) -> dict:
    counts = {name: len(rx.findall(blob)) for name, rx in TEXT_TERMS}
    tlv = 0
    for match in BECH32_TOKEN.finditer(blob):
        token = match.group(0).decode("ascii").lower()
        if token == DAN_NPUB:
            continue  # counted as dan-npub
        decoded = bech32_decode(token)
        if decoded is not None and key in decoded[1]:
            tlv += 1
    counts["dan-bech32-tlv"] = tlv
    return counts


def manifest_hits(raw: bytes) -> int:
    doc = json.loads(raw.decode("utf-8"))
    if not isinstance(doc, dict):
        raise CIError("manifest is not a JSON object")
    hits = 0
    for field in ("name", "short_name"):
        value = doc.get(field)
        if not isinstance(value, str) or not value:
            raise CIError("manifest %s is missing" % field)
        if re.search(r"gitworkshop", value, re.IGNORECASE):
            hits += 1
    return hits


def og_url_hits(html: bytes) -> int:
    metas = OG_URL.findall(html)
    if len(metas) != 1:
        return 1
    content = CONTENT_ATTR.search(metas[0])
    if content is None or content.group(1) != EXPECTED_OG_URL.encode():
        return 1
    return 0


def scan_dist(dist: str, min_files: int, manifest: str) -> tuple:
    key = bytes.fromhex(DAN_HEX)
    totals = {name: 0 for name in ALL_TERMS}
    per_file = {name: {} for name in ALL_TERMS}
    # Fails on any symlink in dist, to a file or to a directory.
    paths = sovci.regular_files(dist, "dist")
    files = len(paths)
    for path in paths:
        rel = os.path.relpath(path, dist)
        if path.endswith(".map"):
            raise CIError("source maps must be moved out before the ratchet")
        with open(path, "rb") as handle:
            blob = handle.read()
        for term, n in count_text(blob, key).items():
            if n:
                totals[term] += n
                per_file[term][rel] = n
    if files < min_files:
        raise CIError("dist has %d file(s), floor is %d" % (files, min_files))
    manifest_path = os.path.join(dist, manifest)
    if not os.path.isfile(manifest_path):
        raise CIError("dist/%s is missing" % manifest)
    with open(manifest_path, "rb") as handle:
        hits = manifest_hits(handle.read())
    if hits:
        totals["manifest-name"] = hits
        per_file["manifest-name"][manifest] = hits
    for page in ("index.html", "404.html"):
        page_path = os.path.join(dist, page)
        if not os.path.isfile(page_path):
            if page == "index.html":
                raise CIError("dist/index.html is missing")
            continue
        with open(page_path, "rb") as handle:
            if og_url_hits(handle.read()):
                totals["og-url"] += 1
                per_file["og-url"][page] = 1
    return totals, per_file, files


# --- allowlist ---


def load_allowlist(path: str) -> dict:
    with open(path, "rb") as handle:
        doc = json.loads(handle.read().decode("utf-8"))
    if not isinstance(doc, dict):
        raise CIError("allowlist is not a JSON object")
    extra = set(doc) - {"note", "functional", "pending"}
    if extra or "functional" not in doc or "pending" not in doc:
        raise CIError("allowlist keys must be note, functional and pending")
    expected = {"functional": {}, "pending": {}}
    for section, why in (("functional", "reason"), ("pending", "removed_by")):
        entries = doc[section]
        if not isinstance(entries, list):
            raise CIError("allowlist %s must be a list" % section)
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"term", "count", why}:
                raise CIError("allowlist %s entries need term, count, %s" % (section, why))
            term, count, text = entry["term"], entry["count"], entry[why]
            if term not in ALL_TERMS:
                raise CIError("allowlist %s names an unknown term" % section)
            if type(count) is not int or count < 1:
                raise CIError("allowlist %s count must be a positive integer" % section)
            if not isinstance(text, str) or not text.strip():
                raise CIError("allowlist %s %s must be non-empty" % (section, why))
            if term in expected[section]:
                raise CIError("allowlist %s lists a term twice" % section)
            expected[section][term] = count
    return expected


# --- positive control ---


def self_test() -> None:
    sovci.regular_files_self_test()
    key = bytes.fromhex(DAN_HEX)
    decoded = bech32_decode(DAN_NPUB)
    if decoded is None or decoded != ("npub", key):
        raise CIError("self-test: bech32 decoder does not round-trip the npub")
    nprofile = bech32_encode("nprofile", bytes([0, 32]) + key + bytes([1, 4]) + b"wss:")
    sample = b" ".join(
        [
            b"GitWorkshop",
            b"https://gitworkshop.dev/x",
            b"<span>GITWORKSHOP.DEV</span>",
            b"DanConwayDev",
            b"wss://nos.lol",
            DAN_NPUB.encode(),
            DAN_HEX.encode(),
            b"nostr:" + nprofile.encode(),
        ]
    )
    counts = count_text(sample, key)
    want = {name: 1 for name, _ in TEXT_TERMS}
    # The host term fires on the URL and on the bare, upper-case host.
    want["gitworkshop-host"] = 2
    want["dan-bech32-tlv"] = 1
    if counts != want:
        raise CIError("self-test: a brand term did not fire the expected number of times")
    clean = count_text(
        b"gitworkshop-outbox chronos.lol GitWorkshops npub1qqqqqq"
        b" mygitworkshop.dev gitworkshop.devs gitworkshop-dev.io",
        key,
    )
    if any(clean.values()):
        raise CIError("self-test: a brand term fired on the clean sample")
    if manifest_hits(b'{"name": "GitWorkshop.dev", "short_name": "SovTech Git"}') != 1:
        raise CIError("self-test: manifest check did not fire")
    good = b'<meta property="og:url" content="https://git.sovtech.pro/" />'
    bad = b'<meta property="og:url" content="https://gitworkshop.dev/" />'
    if og_url_hits(good) != 0 or og_url_hits(bad) != 1:
        raise CIError("self-test: og:url check misfired")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dist", required=True)
    parser.add_argument("--allowlist", default="ci/sovtech/brand-allowlist.json")
    parser.add_argument("--manifest", default="manifest.webmanifest")
    parser.add_argument("--min-files", type=int, default=10)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--release", action="store_true")
    mode.add_argument("--baseline", action="store_true")
    parser.add_argument("--self-test-only", action="store_true")
    args = parser.parse_args()
    try:
        self_test()
        print("ok   brand-self-test: every term fired on the synthetic sample; a symlink in a tree fails the walk")
        if args.self_test_only:
            return sovci.EXIT_OK
        expected = load_allowlist(args.allowlist)
        totals, per_file, files = scan_dist(args.dist, args.min_files, args.manifest)
    except (CIError, OSError, ValueError) as exc:
        print("ERROR brand-leak: %s" % sovci.safe(str(exc)))
        return sovci.EXIT_ERROR

    print("brand-leak: %d file(s) scanned" % files)
    failures = 0
    for term in ALL_TERMS:
        functional = expected["functional"].get(term, 0)
        pending = expected["pending"].get(term, 0)
        seen = totals[term]
        status = "ok  " if seen == functional + pending else "FAIL"
        if args.baseline:
            status = "info"
        elif status == "FAIL":
            failures += 1
        print(
            "%s %s: seen=%d functional=%d pending=%d"
            % (status, term, seen, functional, pending)
        )
        if seen and (status != "ok  " or args.baseline):
            for rel, n in sorted(per_file[term].items()):
                print("       %s: %d" % (sovci.safe(rel), n))
    if args.release and expected["pending"]:
        failures += 1
        print("FAIL release: pending must be empty (%d term(s))" % len(expected["pending"]))
    if args.baseline or failures:
        seed = [
            {"term": t, "count": totals[t] - expected["functional"].get(t, 0),
             "removed_by": "<MR that removes it>"}
            for t in ALL_TERMS
            if totals[t] - expected["functional"].get(t, 0) > 0
        ]
        print("brand-leak: pending section matching this dist:")
        print(json.dumps(seed, indent=2))
    if args.baseline:
        return sovci.EXIT_OK
    return sovci.EXIT_FINDINGS if failures else sovci.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
