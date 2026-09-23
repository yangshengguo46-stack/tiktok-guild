"""Verify the approved CreatorAgent package against its SHA-256 manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

DEFAULT_ASSET_ROOT = Path(__file__).resolve().parents[1] / "docs" / "product" / "creator-agent-final-persona-rev1"


def verify_assets(root: Path) -> tuple[int, int]:
    if root.is_symlink():
        raise ValueError(f"asset root symlink is not allowed: {root}")
    root = root.resolve()
    manifest_path = root / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("manifest files must be a nonempty list")

    declared: dict[str, tuple[int, str]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"}:
            raise ValueError("invalid manifest file entry")
        name = entry["path"]
        if not isinstance(name, str) or not name or PurePosixPath(name).is_absolute() or any(part in {".", ".."} for part in name.split("/")):
            raise ValueError(f"unsafe manifest path: {name!r}")
        if name == "MANIFEST.json" or name in declared:
            raise ValueError(f"duplicate or self-referential manifest path: {name}")
        size, digest = entry["bytes"], entry["sha256"]
        if type(size) is not int or size < 0 or not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError(f"invalid manifest hash metadata: {name}")
        declared[name] = (size, digest)

    actual: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"asset symlink is not allowed: {path.relative_to(root)}")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    expected = set(declared) | {"MANIFEST.json"}
    if actual != expected:
        raise ValueError(f"asset file set mismatch: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")

    total_bytes = 0
    for name, (size, digest) in declared.items():
        data = (root / name).read_bytes()
        total_bytes += len(data)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"asset hash mismatch: {name}")
    return len(declared), total_bytes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=DEFAULT_ASSET_ROOT)
    args = parser.parse_args()
    count, size = verify_assets(args.root)
    print(f"Verified {count} manifest files ({size} bytes) in {args.root}")


if __name__ == "__main__":
    main()
