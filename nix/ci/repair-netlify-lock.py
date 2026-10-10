"""Restore omitted download metadata without changing Netlify's locked versions."""

import json
import sys
from pathlib import Path

lockfile = Path("package-lock.json")
lock = json.loads(lockfile.read_text())
metadata = json.loads(Path(sys.argv[1]).read_text())
for location, package in lock["packages"].items():
    if not location or package.get("inBundle") or package.get("link"):
        continue
    if package.get("resolved") and package.get("integrity"):
        continue
    name = package.get("name", location.rsplit("node_modules/", 1)[-1])
    pinned = metadata[f"{name}@{package['version']}"]
    for field in ("resolved", "integrity"):
        package.setdefault(field, pinned[field])
lockfile.write_text(json.dumps(lock, indent=2) + "\n")
