#!/usr/bin/env python3
"""Builds the extension for a browser store (or for loading by hand).

    python scripts/package_extension.py                  # Chrome: dist/inkling-extension-<version>.zip
    python scripts/package_extension.py --firefox        # Firefox: dist/inkling-extension-<version>-firefox.zip
    python scripts/package_extension.py --unpacked DIR   # the files themselves in DIR (to load unpacked), not a zip
    python scripts/package_extension.py -o my.zip

Only what the extension needs when it runs goes in: the manifest, the pages, the code, the language files and the
icons. The tests, the README and package.json stay out. The script also checks that every file the manifest names is
in the package and that no file is bigger than a store would expect, so a bad package fails here and not at upload.

The Firefox build is the same code with a different manifest: Firefox needs an add-on id (and says what data it
collects), and has no use for Chrome's minimum version.
"""
import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "extension"
LEFT_OUT = {"test", "node_modules", "package.json", "package-lock.json", "README.md"}
BIGGEST_FILE = 1_000_000

# The add-on's identity for Firefox. Change it before publishing under another name: an id is what an update is matched to.
FIREFOX_ID = "inkling-extension@oblutack.github.io"
# 140 is the oldest Firefox (it is also the ESR) that knows `data_collection_permissions`.
FIREFOX_MIN_VERSION = "140.0"


def runtime_files() -> list[Path]:
    files = []
    for path in sorted(SOURCE.rglob("*")):
        relative = path.relative_to(SOURCE)
        if path.is_dir() or relative.parts[0] in LEFT_OUT:
            continue
        files.append(path)
    return files


def firefox_manifest(manifest: dict) -> dict:
    result = {k: v for k, v in manifest.items() if k != "minimum_chrome_version"}
    result["browser_specific_settings"] = {
        "gecko": {
            "id": FIREFOX_ID,
            "strict_min_version": FIREFOX_MIN_VERSION,
            # What the add-on sends is sent where the person points it (their own Inkling server): nothing goes to the
            # people who make the add-on, so it collects nothing itself.
            "data_collection_permissions": {"required": ["none"]},
        },
        # Firefox for Android only knows `data_collection_permissions` from 142.
        "gecko_android": {"strict_min_version": "142.0"},
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--firefox", action="store_true", help="build the Firefox variant")
    parser.add_argument("--unpacked", metavar="DIR", help="write the files into DIR instead of making a zip")
    parser.add_argument("-o", "--output", help="where to write the zip (default: dist/inkling-extension-<version>[-firefox].zip)")
    args = parser.parse_args()

    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if args.firefox:
        manifest = firefox_manifest(manifest)
    manifest_bytes = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

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

    def content(path: Path) -> bytes:
        return manifest_bytes if path.relative_to(SOURCE).as_posix() == "manifest.json" else path.read_bytes()

    if args.unpacked:
        target = Path(args.unpacked)
        if target.exists():
            shutil.rmtree(target)
        for path in files:
            destination = target / path.relative_to(SOURCE)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content(path))
        print(f"{target} ({len(files)} files, version {version}{', Firefox' if args.firefox else ''})")
        return 0

    suffix = "-firefox" if args.firefox else ""
    output = Path(args.output) if args.output else ROOT / "dist" / f"inkling-extension-{version}{suffix}.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            # a fixed time, so the same files always make the same zip
            info = zipfile.ZipInfo(path.relative_to(SOURCE).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, content(path))

    print(f"{output} ({output.stat().st_size / 1024:.0f} KB, {len(files)} files, version {version}{', Firefox' if args.firefox else ''})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
