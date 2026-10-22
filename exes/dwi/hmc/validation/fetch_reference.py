#!/usr/bin/env python3
"""Fetch named subsets of the pinned hmc reference data for the exes/dwi tests.

    python3 exes/dwi/hmc/validation/fetch_reference.py DEST SUBSET [SUBSET ...]

SUBSET is a name under "subsets" in reference.manifest.json beside this script
(decomposition, clip, gp, nifreeze-replay, shore), or `all`. The files go to DEST in
the folder's own layout (DEST/input/..., DEST/nifreeze-gp/...), so DEST can hold
several subsets and later runs add to it. A file already in DEST with the manifest's
size and sha256 is not downloaded again; every download is checked the same way.

Progress goes to stderr. stdout gets the variables for the tests, one KEY=VALUE per
line, for `>> "$GITHUB_ENV"` in CI or `export $(...)` in a shell:

    export $(python3 exes/dwi/hmc/validation/fetch_reference.py /var/tmp/hmc-ref clip gp)
    HMC_REQUIRE_REFERENCE=1 cargo test --release --locked --workspace

Patterns are fnmatch globs in which `*` also crosses `/`. Standard library only.
"""

import concurrent.futures
import fnmatch
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "reference.manifest.json")
ATTEMPTS = 8
THREADS = 4


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def verified(path, entry):
    return (
        os.path.isfile(path)
        and os.path.getsize(path) == entry["bytes"]
        and sha256(path) == entry["sha256"]
    )


def fetch(base, dest, entry):
    path = os.path.join(dest, entry["path"])
    if verified(path, entry):
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with (
                urllib.request.urlopen(base + entry["path"], timeout=120) as r,
                open(path + ".part", "wb") as f,
            ):
                shutil.copyfileobj(r, f, 1 << 22)
            break
        except OSError as e:
            if attempt == ATTEMPTS:
                raise
            # Hugging Face answers 429 after a few thousand requests: wait as long as it asks.
            wait = 5 * attempt
            if isinstance(e, urllib.error.HTTPError) and e.code == 429:
                wait = max(wait, int(e.headers.get("Retry-After") or 60))
            print(
                f"  {entry['path']}: retrying in {wait} s ({e})",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(wait)
    if not verified(path + ".part", entry):
        sys.exit(f"{entry['path']}: size or sha256 does not match the manifest")
    os.replace(path + ".part", path)
    return True


def select(manifest, names):
    subsets = manifest["subsets"]
    if names == ["all"]:
        return list(subsets), manifest["files"]
    unknown = [n for n in names if n not in subsets]
    if unknown:
        sys.exit(
            f"unknown subset {', '.join(unknown)}; choose from {', '.join(subsets)} or all"
        )
    patterns = [p for n in names for p in subsets[n]["patterns"]]
    files = [
        e
        for e in manifest["files"]
        if any(fnmatch.fnmatchcase(e["path"], p) for p in patterns)
    ]
    return names, files


def main(dest, names):
    with open(MANIFEST) as f:
        manifest = json.load(f)
    dest = os.path.abspath(dest)
    names, files = select(manifest, names)
    total = sum(e["bytes"] for e in files)
    print(
        f"{', '.join(names)}: {len(files)} files, {total / 1e6:.1f} MB",
        file=sys.stderr,
        flush=True,
    )
    with concurrent.futures.ThreadPoolExecutor(THREADS) as pool:
        fetched = sum(pool.map(lambda e: fetch(manifest["base"], dest, e), files))
    print(
        f"{dest}: {fetched} downloaded, {len(files) - fetched} already verified",
        file=sys.stderr,
        flush=True,
    )
    print(f"HMC_REFERENCE={dest}")
    print(f"HMC_REFERENCE_SUBSETS={','.join(names)}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
