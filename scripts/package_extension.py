#!/usr/bin/env python3
"""Builds the zip file that is uploaded to the Chrome Web Store (or loaded by a person who is given the file).

    python scripts/package_extension.py            # -> dist/inkling-extension-<version>.zip
    python scripts/package_extension.py -o my.zip

Only what the extension needs when it runs goes in: the manifest, the pages, the code, the language files and the
icons. The tests, this folder's README and package.json stay out. The script also checks that every file the manifest
names is in the zip and that no file is bigger than a store would expect, so a bad package fails here and not at upload.
"""
import argparse
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "extension"
LEFT_OUT = {"test", "node_modules", "package.json", "package-lock.json", "README.md"}
BIGGEST_FILE = 1_000_000


def runtime_files() -> list[Path]:
    files = []
    for path in sorted(SOURCE.rglob("*")):
        relative = path.relative_to(SOURCE)
        if path.is_dir() or relative.parts[0] in LEFT_OUT:
            continue
        files.append(path)
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-o", "--output", help="where to write the zip (default: dist/inkling-extension-<version>.zip)")
    args = parser.parse_args()

    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    output = Path(args.output) if args.output else ROOT / "dist" / f"inkling-extension-{version}.zip"
    output.parent.mkdir(parents=True, exist_ok=True)

    files = runtime_files()
    named = [manifest["action"]["default_popup"], manifest["options_ui"]["page"], *manifest["icons"].values()]
    present = {p.relative_to(SOURCE).as_posix() for p in files}
    missing = [n for n in named if n not in present]
    if missing:
        print("the manifest names files that are not there:", ", ".join(missing), file=sys.stderr)
        return 1
    too_big = [p.name for p in files if p.stat().st_size > BIGGEST_FILE]
    if too_big:
        print("files bigger than 1 MB:", ", ".join(too_big), file=sys.stderr)
        return 1

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            # a fixed time, so the same files always make the same zip
            info = zipfile.ZipInfo(path.relative_to(SOURCE).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())

    print(f"{output} ({output.stat().st_size / 1024:.0f} KB, {len(files)} files, version {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
