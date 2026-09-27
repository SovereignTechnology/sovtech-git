#!/usr/bin/env -S python3 -I
"""Regenerate SovTech Git's brand assets from src/sovtech/brand/mark.svg.

Laptop only, never CI: the rasteriser is the system Chromium, run headless
with a throwaway profile directory (never a real browser profile). Nothing
else is needed beyond the Python 3 standard library: no npm, no packages.

Usage: python3 -I ci/sovtech/gen-brand-assets.py [--chromium PATH]

Writes, under upstream's file names and pixel sizes:

  src/sovtech/brand/mark-on-dark.svg, public/favicon.svg, public/icons/icon.svg
      the mark on a #0A0A0A rounded tile, colours baked in;
  public/favicon.ico
      16, 32 and 48 px tiles as PNG entries;
  public/favicon.png, public/icons/icon-<N>x<N>.png
      the tile, transparent outside its rounded corners;
  public/icons/apple-touch-icon.png
      180 px, an opaque #0A0A0A square (iOS rounds it);
  public/icons/pwa-maskable-192x192.png, public/icons/pwa-maskable-512x512.png
      opaque, with the whole mark inside the central 80% safe zone;
  public/icon.png
      512 px, the NIP-11 relay icon (the maskable composition).

Opaque images are written as RGB PNGs, so they cannot carry transparency.
The script then prints each public/ file's git blob id in the
ci/sovtech/asset-swaps.tsv format. Chromium versions may anti-alias
differently, so a re-run can change the PNG bytes: commit the regenerated
files and their new blob ids together.
"""

import sys

# Same isolation guard as the other ci/sovtech scripts: run as python3 -I so
# neither the script's directory nor the working directory is on sys.path.
if not sys.flags.isolated or sys.version_info < (3, 10):
    sys.stderr.write("ERROR: run this script with python3 -I (Python 3.10 or later)\n")
    sys.exit(4)
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE

import argparse
import base64
import html
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import zlib

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MARK = "src/sovtech/brand/mark.svg"
TILE_SVG = "src/sovtech/brand/mark-on-dark.svg"
BACKGROUND = "#0A0A0A"

# Composition in a 64-unit square: (mark box side as a fraction of the icon,
# corner radius, opaque). The mark's viewBox is square and centred on its
# ink, so the box is centred too. Maskable: the ink's half-diagonal is 0.37
# of the icon's side, inside the 0.40 safe-zone radius.
KINDS = {
    "tile": (0.70, 16, False),
    "square": (0.62, 0, True),
    "maskable": (0.58, 0, True),
}
TILE_SIZES = (16, 32, 48, 57, 60, 76, 120, 152, 180, 192, 512)
ICO_SIZES = (16, 32, 48)


class GenError(Exception):
    pass


def read_mark() -> tuple:
    """(root start tag without its closing '>', inner markup) of mark.svg."""
    with open(os.path.join(REPO, MARK), "r", encoding="utf-8") as handle:
        text = handle.read()
    if not text.isascii():
        raise GenError("%s must be ASCII" % MARK)
    match = re.fullmatch(r"\s*(<svg\b[^>]*?)\s*>(.*)</svg>\s*", text, re.DOTALL)
    if match is None or 'viewBox="' not in match.group(1):
        raise GenError("%s must be one <svg> root with a viewBox" % MARK)
    start, inner = match.group(1), match.group(2)
    if re.search(r"\s(x|y|width|height)=", start):
        raise GenError("%s root must not set x, y, width or height" % MARK)
    return start, inner


def number(value: float) -> str:
    return format(round(value, 4), "g")


def compose(kind: str, mark: tuple, px: int) -> str:
    """The icon as a standalone SVG document, px wide and high."""
    fraction, radius, _ = KINDS[kind]
    side = 64 * fraction
    offset = (64 - side) / 2
    start, inner = mark
    corner = ' rx="%d"' % radius if radius else ""
    nested = '%s x="%s" y="%s" width="%s" height="%s">' % (
        start.replace(' xmlns="http://www.w3.org/2000/svg"', ""),
        number(offset),
        number(offset),
        number(side),
        number(side),
    )
    body = "\n".join("  " + line if line.strip() else line for line in inner.strip("\n").split("\n"))
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 64 64">\n'
        '  <rect width="64" height="64"%s fill="%s"/>\n'
        "  %s\n%s\n  </svg>\n"
        "</svg>\n"
    ) % (px, px, corner, BACKGROUND, nested, body)


PAGE = """<!doctype html>
<meta charset="utf-8">
<title>pending</title>
<pre id="out"></pre>
<script>
const jobs = JOBS;
function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}
(async () => {
  const out = {};
  for (const [key, px, svg] of jobs) {
    const image = new Image(px, px);
    image.src = "data:image/svg+xml;base64," + btoa(svg);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, px, px);
    context.drawImage(image, 0, 0, px, px);
    out[key] = base64(context.getImageData(0, 0, px, px).data);
  }
  document.getElementById("out").textContent = JSON.stringify(out);
  document.title = "done";
})().catch((error) => {
  document.getElementById("out").textContent = "ERROR " + error;
});
</script>
"""


def rasterise(chromium: str, jobs: list) -> dict:
    """{key: RGBA bytes} for [(key, px, svg)], drawn by headless Chromium."""
    payload = json.dumps(jobs).replace("</", "<\\/")
    page = PAGE.replace("JOBS", payload)
    url = "data:text/html;base64," + base64.b64encode(page.encode("ascii")).decode("ascii")
    profile = tempfile.mkdtemp(prefix="sovtech-brand-chromium-")
    try:
        proc = subprocess.run(
            [
                chromium,
                "--headless=new",
                "--disable-gpu",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-extensions",
                "--disable-sync",
                "--no-first-run",
                "--no-default-browser-check",
                "--force-color-profile=srgb",
                "--user-data-dir=" + profile,
                "--virtual-time-budget=30000",
                "--dump-dom",
                url,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=300,
            check=False,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    dom = proc.stdout.decode("utf-8", "replace")
    if proc.returncode != 0 or "<title>done</title>" not in dom:
        raise GenError("chromium did not finish the render (exit %d)" % proc.returncode)
    match = re.search(r'<pre id="out">(.*?)</pre>', dom, re.DOTALL)
    if match is None:
        raise GenError("chromium output has no result block")
    results = json.loads(html.unescape(match.group(1)))
    out = {}
    for key, px, _ in jobs:
        data = base64.b64decode(results[key], validate=True)
        if len(data) != px * px * 4:
            raise GenError("%s: got %d bytes, expected %d" % (key, len(data), px * px * 4))
        out[key] = data
    return out


def filter_rows(rows: list, bpp: int) -> bytes:
    """PNG scanlines, each with the None, Sub or Up filter whose output has
    the smallest sum of absolute (signed) values."""
    out = []
    previous = bytes(len(rows[0]))
    for row in rows:
        candidates = [
            (0, row),
            (1, bytes((row[i] - (row[i - bpp] if i >= bpp else 0)) & 0xFF for i in range(len(row)))),
            (2, bytes((row[i] - previous[i]) & 0xFF for i in range(len(row)))),
        ]
        kind, data = min(candidates, key=lambda c: sum(b if b < 128 else 256 - b for b in c[1]))
        out.append(bytes([kind]) + data)
        previous = row
    return b"".join(out)


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def encode_png(rgba: bytes, px: int, opaque: bool) -> bytes:
    if opaque:
        if any(alpha != 255 for alpha in rgba[3::4]):
            raise GenError("an opaque composition rendered transparent pixels")
        pixels = bytearray(px * px * 3)
        pixels[0::3], pixels[1::3], pixels[2::3] = rgba[0::4], rgba[1::4], rgba[2::4]
        bpp, colour = 3, 2
    else:
        pixels, bpp, colour = rgba, 4, 6
    stride = px * bpp
    rows = [bytes(pixels[y * stride : (y + 1) * stride]) for y in range(px)]
    header = struct.pack(">IIBBBBB", px, px, 8, colour, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(filter_rows(rows, bpp), 9))
        + chunk(b"IEND", b"")
    )


def encode_ico(images: list) -> bytes:
    """An ICO container of [(px, png bytes)] with PNG entries."""
    out = [struct.pack("<HHH", 0, 1, len(images))]
    offset = 6 + 16 * len(images)
    for px, data in images:
        side = px if px < 256 else 0
        out.append(struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    out.extend(data for _, data in images)
    return b"".join(out)


def write(relative: str, data: bytes) -> None:
    path = os.path.join(REPO, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    print("wrote %s (%d bytes)" % (relative, len(data)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chromium", help="Chromium or Chrome binary (default: from PATH)")
    args = parser.parse_args()
    try:
        chromium = args.chromium or next(
            (found for name in ("chromium", "chromium-browser", "google-chrome")
             if (found := shutil.which(name))),
            None,
        )
        if not chromium:
            raise GenError("no Chromium on PATH; pass --chromium")
        mark = read_mark()

        svg = compose("tile", mark, 64).encode("ascii")
        for relative in (TILE_SVG, "public/favicon.svg", "public/icons/icon.svg"):
            write(relative, svg)

        renders = [("tile", px) for px in TILE_SIZES] + [
            ("square", 180),
            ("maskable", 192),
            ("maskable", 512),
        ]
        jobs = [("%s-%d" % (kind, px), px, compose(kind, mark, px)) for kind, px in renders]
        pixels = rasterise(chromium, jobs)
        png = {
            (kind, px): encode_png(pixels["%s-%d" % (kind, px)], px, KINDS[kind][2])
            for kind, px in renders
        }

        for px in TILE_SIZES:
            write("public/icons/icon-%dx%d.png" % (px, px), png[("tile", px)])
        write("public/favicon.png", png[("tile", 32)])
        write("public/favicon.ico", encode_ico([(px, png[("tile", px)]) for px in ICO_SIZES]))
        write("public/icons/apple-touch-icon.png", png[("square", 180)])
        for px in (192, 512):
            write("public/icons/pwa-maskable-%dx%d.png" % (px, px), png[("maskable", px)])
        write("public/icon.png", png[("maskable", 512)])
    except (GenError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print("ERROR gen-brand-assets: %s" % exc, file=sys.stderr)
        return 4

    print("asset-swaps.tsv rows (path, fork_blob):")
    listed = subprocess.run(
        ["git", "-C", REPO, "ls-files", "--others", "--cached", "--exclude-standard", "--", "public"],
        stdout=subprocess.PIPE,
        check=True,
    ).stdout.decode("utf-8").split("\n")
    outputs = [p for p in sorted(listed) if re.fullmatch(r"public/(favicon\.\w+|icon\.png|icons/.+)", p)]
    for relative in outputs:
        blob = subprocess.run(
            ["git", "-C", REPO, "hash-object", "--", relative],
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.decode("ascii").strip()
        print("%s\t%s" % (relative, blob))
    return 0


if __name__ == "__main__":
    sys.exit(main())
