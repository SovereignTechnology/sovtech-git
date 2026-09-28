#!/usr/bin/env -S python3 -I
"""Regenerate SovTech Git's brand assets from src/sovtech/brand/mark.svg.

Generating is laptop only, never CI: the rasteriser is the system Chromium,
run headless with a throwaway profile directory (never a real browser
profile). Nothing else is needed beyond the Python 3 standard library: no
npm, no packages.

Usage: python3 -I ci/sovtech/gen-brand-assets.py [--chromium PATH]
       python3 -I ci/sovtech/gen-brand-assets.py --check

--check (gate.sh --phase history; standard library only, no Chromium)
reads the committed files at HEAD and checks everything that does not need
the rasteriser: mark.svg passes the element and attribute allow-list; the
three SVGs are byte for byte the mark composed on its tile; every PNG is
exactly IHDR, IDAT and IEND, 8-bit, not interlaced, with the pixel size of
its name and colour type 2 (opaque RGB) or 6 (the tiles); favicon.ico is
the committed 16, 32 and 48 px tiles; favicon.png and icon.png equal the
files they copy; and the maskable icons, decoded, keep every pixel outside
the safe zone plain background. First a synthetic image must round-trip
through encode_png and the decoder, and planted faults must be refused: an
onload, a script, a style attribute, a comment and a url() value in the
mark; an extra chunk, a wrong colour type and a wrong size in a PNG; ink
outside the safe zone. Exit 0 when clean, 3 on findings, 4 when the check
cannot run.

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

SVG_OUTPUTS = (TILE_SVG, "public/favicon.svg", "public/icons/icon.svg")
ICO_OUTPUT = "public/favicon.ico"

# Composition in a 64-unit square: (mark box side as a fraction of the icon,
# corner radius, opaque). The mark's viewBox is square and centred on its
# ink, so the box is centred too. Maskable: the farthest ink (the stub ends)
# is 0.31 of the icon's side from its centre (the ink's bounding box has a
# half-diagonal of 0.37), inside the 0.40 safe-zone radius.
KINDS = {
    "tile": (0.70, 16, False),
    "square": (0.62, 0, True),
    "maskable": (0.58, 0, True),
}
TILE_SIZES = (16, 32, 48, 57, 60, 76, 120, 152, 180, 192, 512)
ICO_SIZES = (16, 32, 48)
SAFE_ZONE = 0.40  # maskable: radius of the safe circle, as a fraction of the side
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Outputs written twice: (copy, original).
COPIES = (
    ("public/favicon.png", "public/icons/icon-32x32.png"),
    ("public/icon.png", "public/icons/pwa-maskable-512x512.png"),
)


def png_outputs() -> list:
    """(path, kind, px) for every PNG this script writes."""
    out = [("public/icons/icon-%dx%d.png" % (px, px), "tile", px) for px in TILE_SIZES]
    out += [
        ("public/favicon.png", "tile", 32),
        ("public/icons/apple-touch-icon.png", "square", 180),
        ("public/icons/pwa-maskable-192x192.png", "maskable", 192),
        ("public/icons/pwa-maskable-512x512.png", "maskable", 512),
        ("public/icon.png", "maskable", 512),
    ]
    return out

# mark.svg ends up inlined in same-origin SVG files (favicon.svg), so it may
# hold only these elements and attributes, with plain quoted values: no
# script, event handler, link, style, entity, comment or doctype.
ALLOWED_ELEMENTS = {"svg", "g", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse"}
ALLOWED_ATTRIBUTES = {
    "xmlns", "viewBox", "fill", "fill-rule", "clip-rule", "stroke", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "d", "points",
    "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height",
}
TAG = re.compile(r'<(/?)([a-z]+)((?:\s+[A-Za-z-]+="[^"<>&]*")*)\s*(/?)>')
ATTRIBUTE = re.compile(r'([A-Za-z-]+)="([^"<>&]*)"')
# Values are numbers, path data, #hex colours and keywords: no url(), no
# ":" or "/", so no value can reference another resource. xmlns is exact.
PLAIN_VALUE = re.compile(r"[A-Za-z0-9 .,#%+-]*")
SVG_NAMESPACE = "http://www.w3.org/2000/svg"


class GenError(Exception):
    pass


def read_mark() -> tuple:
    """(root start tag without its closing '>', inner markup) of mark.svg."""
    with open(os.path.join(REPO, MARK), "r", encoding="utf-8") as handle:
        return parse_mark(handle.read())


def parse_mark(text: str) -> tuple:
    """read_mark() for mark.svg's text; refuses anything off the allow-list."""
    if not text.isascii():
        raise GenError("%s must be ASCII" % MARK)
    position = 0
    for tag in re.finditer(r"<[^>]*>", text):
        if text[position : tag.start()].strip():
            raise GenError("%s may hold only elements, no text" % MARK)
        position = tag.end()
        match = TAG.fullmatch(tag.group(0))
        if match is None or match.group(2) not in ALLOWED_ELEMENTS:
            raise GenError("%s: a tag is not an allowed SVG shape element" % MARK)
        for name, value in ATTRIBUTE.findall(match.group(3)):
            if name not in ALLOWED_ATTRIBUTES:
                raise GenError("%s: attribute %s is not allowed" % (MARK, name))
            if name == "xmlns":
                plain = value == SVG_NAMESPACE
            else:
                plain = PLAIN_VALUE.fullmatch(value) is not None
            if not plain:
                raise GenError("%s: attribute %s has a value that is not plain" % (MARK, name))
    if text[position:].strip():
        raise GenError("%s may hold only elements, no text" % MARK)
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


def check_safe_zone(rgba: bytes, px: int, key: str) -> None:
    """Every pixel outside the maskable safe circle is the plain background."""
    background = bytes.fromhex(BACKGROUND[1:]) + b"\xff"
    limit = (SAFE_ZONE * px) ** 2
    centre = px / 2
    for y in range(px):
        for x in range(px):
            if (x + 0.5 - centre) ** 2 + (y + 0.5 - centre) ** 2 > limit:
                offset = (y * px + x) * 4
                if rgba[offset : offset + 4] != background:
                    raise GenError("%s: the mark leaves the maskable safe zone" % key)


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


def png_chunks(data: bytes, name: str) -> list:
    """[(type, body)] of a PNG, every CRC checked, nothing after the last."""
    if not data.startswith(PNG_SIGNATURE):
        raise GenError("%s is not a PNG" % name)
    chunks, position = [], len(PNG_SIGNATURE)
    while position < len(data):
        if position + 12 > len(data):
            raise GenError("%s: truncated chunk" % name)
        (length,) = struct.unpack(">I", data[position : position + 4])
        end = position + 12 + length
        if end > len(data):
            raise GenError("%s: truncated chunk" % name)
        kind, body = data[position + 4 : position + 8], data[position + 8 : end - 4]
        if struct.unpack(">I", data[end - 4 : end])[0] != zlib.crc32(kind + body):
            raise GenError("%s: bad chunk CRC" % name)
        chunks.append((kind, body))
        position = end
    return chunks


def unfilter(raw: bytes, px: int, bpp: int, name: str) -> bytes:
    """The pixel bytes of px scanlines, each with its PNG filter undone."""
    stride = px * bpp
    out = bytearray()
    previous = bytearray(stride)
    for y in range(px):
        start = y * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1 : start + 1 + stride])
        if kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:
            line = bytearray((a + b) & 0xFF for a, b in zip(line, previous))
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b, c = previous[i], (previous[i - bpp] if i >= bpp else 0)
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        elif kind != 0:
            raise GenError("%s: unknown PNG filter type %d" % (name, kind))
        out += line
        previous = line
    return bytes(out)


def decode_png(data: bytes, px: int, colour: int, name: str) -> bytes:
    """RGBA pixels of a PNG laid out as encode_png writes it: exactly IHDR,
    one IDAT and an empty IEND; px square, 8-bit, the given colour type (2
    or 6), not interlaced. No text, colour profile or transparency chunk."""
    chunks = png_chunks(data, name)
    if [kind for kind, _ in chunks] != [b"IHDR", b"IDAT", b"IEND"] or chunks[2][1]:
        raise GenError("%s: chunks must be exactly IHDR, IDAT and an empty IEND" % name)
    if chunks[0][1] != struct.pack(">IIBBBBB", px, px, 8, colour, 0, 0, 0):
        raise GenError(
            "%s: IHDR is not %dx%d, 8-bit, colour type %d, not interlaced" % (name, px, px, colour)
        )
    bpp = 3 if colour == 2 else 4
    expected = px * (px * bpp + 1)
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(chunks[1][1], expected + 1)
    except zlib.error:
        raise GenError("%s: IDAT does not inflate" % name) from None
    if len(raw) != expected or not inflater.eof or inflater.unconsumed_tail or inflater.unused_data:
        raise GenError("%s: IDAT does not hold exactly %d bytes of scanlines" % (name, expected))
    pixels = unfilter(raw, px, bpp, name)
    if colour == 6:
        return pixels
    rgba = bytearray(b"\xff" * (px * px * 4))
    rgba[0::4], rgba[1::4], rgba[2::4] = pixels[0::3], pixels[1::3], pixels[2::3]
    return bytes(rgba)


def committed(relative: str) -> bytes:
    """relative's bytes at HEAD: --check reads what is committed, not the
    work tree. A symlink reads as its target path, so it never matches."""
    proc = subprocess.run(
        ["git", "-C", REPO, "cat-file", "blob", "HEAD:" + relative],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if proc.returncode != 0:
        raise GenError("%s is missing at HEAD" % relative)
    return proc.stdout


def check_self_test(mark_text: str) -> int:
    """Positive control for --check: a synthetic image round-trips through
    encode_png and decode_png, and each planted fault is refused. Returns
    the number of faults planted."""
    px = 16
    pixels = bytearray((bytes.fromhex(BACKGROUND[1:]) + b"\xff") * (px * px))
    for y in range(5, 11):  # a gradient inside the safe circle
        for x in range(5, 11):
            pixels[(y * px + x) * 4 : (y * px + x) * 4 + 3] = bytes((x * 16, y * 16, x * y))
    pixels = bytes(pixels)
    opaque = encode_png(pixels, px, True)
    for data, colour in ((opaque, 2), (encode_png(pixels, px, False), 6)):
        if decode_png(data, px, colour, "control") != pixels:
            raise GenError("control: the PNG decoder does not round-trip colour type %d" % colour)
    check_safe_zone(pixels, px, "control")

    planted_marks = (
        ("onload", mark_text.replace("<svg ", '<svg onload="alert(1)" ', 1)),
        ("script", mark_text.replace("</svg>", "<script>alert(1)</script></svg>", 1)),
        ("style", mark_text.replace("<path ", '<path style="fill:red" ', 1)),
        ("comment", mark_text.replace("</svg>", "<!-- x --></svg>", 1)),
        ("url value", mark_text.replace("<path ", '<path fill="url(https://x.test/p.svg#a)" ', 1)),
    )
    for case, text in planted_marks:
        if text == mark_text:
            raise GenError("control: could not plant the %s fault in %s" % (case, MARK))
        try:
            parse_mark(text)
        except GenError:
            continue
        raise GenError("control: %s with a planted %s passed the allow-list" % (MARK, case))
    iend = opaque.rindex(b"IEND") - 4
    planted_pngs = (  # (fault, data, expected colour type, expected size)
        ("extra chunk", opaque[:iend] + chunk(b"tEXt", b"k\x00v") + opaque[iend:], 2, px),
        ("colour type", opaque, 6, px),
        ("size", opaque, 2, px * 2),
    )
    for case, data, colour, size in planted_pngs:
        try:
            decode_png(data, size, colour, "control")
        except GenError:
            continue
        raise GenError("control: a PNG with a planted %s fault decoded" % case)
    outside = bytes.fromhex("F7931AFF") + pixels[4:]
    try:
        check_safe_zone(outside, px, "control")
    except GenError:
        return len(planted_marks) + len(planted_pngs) + 1
    raise GenError("control: ink planted outside the safe zone passed")


def check() -> int:
    """--check: 0 when the committed assets pass, 3 on findings."""
    mark_text = committed(MARK).decode("ascii")
    faults = check_self_test(mark_text)
    print("ok   brand-assets-control: %d planted faults refused" % faults)
    findings = []
    try:
        mark = parse_mark(mark_text)
    except GenError as exc:
        print("FAIL brand-assets: %s" % exc)
        return 3
    svg = compose("tile", mark, 64).encode("ascii")
    for relative in SVG_OUTPUTS:
        if committed(relative) != svg:
            findings.append("%s is not the mark composed on its tile" % relative)
    pngs = {}
    for relative, kind, px in png_outputs():
        pngs[relative] = committed(relative)
        try:
            pixels = decode_png(pngs[relative], px, 2 if KINDS[kind][2] else 6, relative)
            if kind == "maskable":
                check_safe_zone(pixels, px, relative)
        except GenError as exc:
            findings.append(str(exc))
    for copy, original in COPIES:
        if pngs[copy] != pngs[original]:
            findings.append("%s differs from %s" % (copy, original))
    ico = encode_ico([(px, pngs["public/icons/icon-%dx%d.png" % (px, px)]) for px in ICO_SIZES])
    if committed(ICO_OUTPUT) != ico:
        findings.append("%s is not the 16, 32 and 48 px tiles" % ICO_OUTPUT)
    for finding in findings:
        print("FAIL brand-assets: %s" % finding)
    if findings:
        return 3
    print(
        "ok   brand-assets: at HEAD, %d SVG(s) are the composed mark, %d PNG(s) "
        "well-formed, maskables inside the safe zone, %s rebuilt from its tiles"
        % (len(SVG_OUTPUTS), len(pngs), ICO_OUTPUT)
    )
    return 0


def write(relative: str, data: bytes) -> None:
    path = os.path.join(REPO, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    print("wrote %s (%d bytes)" % (relative, len(data)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--chromium", help="Chromium or Chrome binary (default: from PATH)")
    mode.add_argument(
        "--check",
        action="store_true",
        help="check the committed assets without Chromium (the gate's history phase)",
    )
    args = parser.parse_args()
    if args.check:
        try:
            return check()
        except (GenError, OSError, ValueError, KeyError) as exc:
            print("ERROR brand-assets: %s" % exc)
            return 4
    try:
        chromium = args.chromium or next(
            (found for name in ("chromium", "chromium-browser", "google-chrome")
             if (found := shutil.which(name))),
            None,
        )
        if not chromium:
            raise GenError("no Chromium on PATH; pass --chromium")
        mark = read_mark()
        outputs = {}
        svg = compose("tile", mark, 64).encode("ascii")
        for relative in SVG_OUTPUTS:
            outputs[relative] = svg

        renders = list(dict.fromkeys((kind, px) for _, kind, px in png_outputs()))
        jobs = [("%s-%d" % (kind, px), px, compose(kind, mark, px)) for kind, px in renders]
        pixels = rasterise(chromium, jobs)
        for kind, px in renders:
            if kind == "maskable":
                check_safe_zone(pixels["%s-%d" % (kind, px)], px, "%s-%d" % (kind, px))
        png = {
            (kind, px): encode_png(pixels["%s-%d" % (kind, px)], px, KINDS[kind][2])
            for kind, px in renders
        }

        for relative, kind, px in png_outputs():
            outputs[relative] = png[(kind, px)]
        outputs[ICO_OUTPUT] = encode_ico([(px, png[("tile", px)]) for px in ICO_SIZES])
        # Nothing is written until every output exists and passed its checks.
        for relative, data in outputs.items():
            write(relative, data)
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
