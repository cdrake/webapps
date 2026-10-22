#!/usr/bin/env python3
"""Fetch the pinned comparison results (inputs, fields, metrics) from Hugging Face.

    python3 fetch_results.py DEST [SUBJECT ...]
    python3 fetch_results.py --pin REVISION

The first form downloads sdc/reverse-pe-options/ of neurodeskorg/webapps at the
revision in results.manifest.json beside this script into DEST, in the folder's own
layout (DEST/<subject>/...). With SUBJECT names it fetches only those subjects (and
the folder's README.md and SHA256SUMS). Every file is checked against the manifest's
size and SHA-256; a verified file is not downloaded again. Then

    python3 aggregate.py DEST

prints the tables of dwi-reverse-pe-options.md. The second form rewrites the
manifest for a new 40-hex dataset commit from that commit's SHA256SUMS and the
Hugging Face tree, and fails when they disagree. Standard library only.
"""

import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request

REPOSITORY = "neurodeskorg/webapps"
ROOT = "sdc/reverse-pe-options"
HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "results.manifest.json")
ATTEMPTS = 8
THREADS = 4


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read(), r.headers.get("Link")


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


def download(dest, subjects):
    with open(MANIFEST) as f:
        manifest = json.load(f)
    known = sorted(
        {e["path"].split("/")[0] for e in manifest["files"] if "/" in e["path"]}
    )
    unknown = [s for s in subjects if s not in known]
    if unknown:
        sys.exit(
            f"unknown subject {', '.join(unknown)}; choose from {', '.join(known)}"
        )
    files = [
        e
        for e in manifest["files"]
        if not subjects or "/" not in e["path"] or e["path"].split("/")[0] in subjects
    ]
    dest = os.path.abspath(dest)
    with concurrent.futures.ThreadPoolExecutor(THREADS) as pool:
        fetched = sum(pool.map(lambda e: fetch(manifest["base"], dest, e), files))
    print(
        f"{dest}: {len(files)} files, {fetched} downloaded, {len(files) - fetched} already verified"
    )


def tree_sizes(revision):
    url = f"https://huggingface.co/api/datasets/{REPOSITORY}/tree/{revision}/{ROOT}?recursive=true"
    sizes = {}
    while url:
        body, link = get(url)
        for item in json.loads(body):
            if item["type"] == "file":
                sizes[item["path"][len(ROOT) + 1 :]] = item["size"]
        match = re.search(r'<([^>]+)>;\s*rel="next"', link or "")
        url = match.group(1) if match else None
    return sizes


def pin(revision):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        sys.exit("REVISION must be a full 40-hex commit")
    base = f"https://huggingface.co/datasets/{REPOSITORY}/resolve/{revision}/{ROOT}/"
    sums_bytes, _ = get(base + "SHA256SUMS")
    sums = {}
    for line in sums_bytes.decode().splitlines():
        digest, path = line.split(None, 1)
        sums[path.lstrip("*").removeprefix("./")] = digest
    sums["SHA256SUMS"] = hashlib.sha256(sums_bytes).hexdigest()
    sizes = tree_sizes(revision)
    if set(sizes) != set(sums):
        sys.exit(
            f"SHA256SUMS and the tree differ: {sorted(set(sizes) ^ set(sums))[:10]}"
        )
    manifest = {
        "description": "Inputs, fields and metrics of dwi-reverse-pe-options.md (#504). "
        "Fetch with fetch_results.py DEST; re-pin with fetch_results.py --pin REVISION.",
        "repository": REPOSITORY,
        "revision": revision,
        "base": base,
        "files": [
            {"path": p, "bytes": sizes[p], "sha256": sums[p]} for p in sorted(sizes)
        ],
    }
    head = json.dumps({k: v for k, v in manifest.items() if k != "files"}, indent=2)
    lines = ",\n".join(
        "    " + json.dumps(e, separators=(", ", ": ")) for e in manifest["files"]
    )
    with open(MANIFEST, "w") as f:
        f.write(head[:-2] + ',\n  "files": [\n' + lines + "\n  ]\n}\n")
    total = sum(sizes.values())
    print(f"{MANIFEST}: {len(sizes)} files, {total / 1e6:.1f} MB at {revision[:12]}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--pin":
        pin(sys.argv[2])
    elif len(sys.argv) >= 2 and not sys.argv[1].startswith("-"):
        download(sys.argv[1], sys.argv[2:])
    else:
        sys.exit(__doc__)
