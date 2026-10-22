#!/usr/bin/env python3
"""Write reference.manifest.json for the hmc reference data on Hugging Face.

    python3 exes/dwi/hmc/validation/make_manifest.py REVISION

REVISION is the 40-hex commit of neurodeskorg/webapps that holds hmc/reference/.
Each file's sha256 comes from the folder's own SHA256SUMS at that commit (and, for
SHA256SUMS itself, from the downloaded bytes). Each file's size comes from the Hugging
Face tree API at the same commit. The subsets are SUBSETS below; a pattern is an
fnmatch glob relative to hmc/reference/ in which `*` also crosses `/`. A pattern that
matches no file is an error, so a typo or a re-pin that drops files fails here.
Standard library only.
"""

import fnmatch
import hashlib
import json
import os
import re
import sys
import urllib.request

REPOSITORY = "neurodeskorg/webapps"
ROOT = "hmc/reference"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "reference.manifest.json")

INPUT_GRADIENTS = ["input/sub-107_dir-AP_dwi.bval", "input/sub-107_dir-AP_dwi.bvec"]

# What each test family needs (issue #438). Keep the patterns to `*` only: the Rust
# test matches them with its own `*` matcher and checks the file counts recorded here.
SUBSETS = {
    "decomposition": [
        *INPUT_GRADIENTS,
        "input/sub-107_dir-AP_dwi.json",
        "input/input-facts.json",
        "nifreeze-*/work/ants-*0GenericAffine.mat",
        "nifreeze-*/work/order.txt",
        "nifreeze-*/motion_affines.tsv",
        "nifreeze-*/motion.tsv",
        "nifreeze-*/motion-check.json",
        "nifreeze-*/out/*.bvec",
        "nifreeze-*/out/*.bval",
        "compare/compare-world-*.json",
        "qsiprep-*/collected/motion_params_*.csv",
        "qsiprep-*/collected/rotated_*.bvec",
        "qsiprep-*/collected/b0/*/transform0GenericAffine.mat",
        "qsiprep-*/collected/model/*/transform0GenericAffine.mat",
        "qsiprep-r1/images/b0_mean.nii.gz",
    ],
    "clip": [
        "nifreeze-gp/bzero.nii.gz",
        "nifreeze-trivial-a1/work/predicted_00000.nii.gz",
        "nifreeze-trivial-a1/clip-facts.json",
    ],
    "gp": [
        "input/*",
        "mask/sub-107_dir-AP_desc-mindgrab_mask.nii.gz",
        "nifreeze-gp/bzero.nii.gz",
        "nifreeze-gp/work/brainmask.nii.gz",
        "nifreeze-gp/work/predicted_*",
        "nifreeze-gp/nifreeze.log",
        "compare/gp-dryrun-*.log",
    ],
    "nifreeze-replay": [
        "input/sub-107_dir-AP_dwi.nii.gz",
        "input/input-facts.json",
        *INPUT_GRADIENTS,
        "nifreeze-gp/work/sample_*",
        "nifreeze-gp/work/predicted_*",
        "nifreeze-trivial-a1/work/predicted_00000.nii.gz",
        "nifreeze-*/work/brainmask.nii.gz",
        "nifreeze-*/work/cmd-*.sh",
        "nifreeze-*/work/ants-*.mat",
        "nifreeze-*/work/order.txt",
        "q53-b0/*",
        "compare/q53-seed-rule.json",
    ],
    "shore": [
        "qsiprep/input/split_dwis/*",
        "qsiprep-r1/collected/model/*/predicted.nii.gz",
        "qsiprep-r1/images/*",
        "qsiprep-*/collected/config.toml",
    ],
}


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read(), r.headers.get("Link")


def tree_sizes(revision):
    """Every file under ROOT at REVISION and its size, following the API's pages."""
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


def matches(pattern, paths):
    if re.search(r"[?\[\]{}]", pattern):
        sys.exit(f"{pattern}: use only `*` in subset patterns")
    hit = [p for p in paths if fnmatch.fnmatchcase(p, pattern)]
    if not hit:
        sys.exit(f"{pattern}: matches no file at this revision")
    return hit


def main(revision):
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
    paths = sorted(sizes)
    subsets = {}
    for name, patterns in SUBSETS.items():
        files = sorted({p for pattern in patterns for p in matches(pattern, paths)})
        subsets[name] = {
            "patterns": patterns,
            "files": len(files),
            "bytes": sum(sizes[p] for p in files),
        }
    manifest = {
        "description": "Head-motion correction reference runs (hmc/reference/, README.md there) "
        "for the exes/dwi tests. Fetch subsets with fetch_reference.py; regenerate with make_manifest.py.",
        "repository": REPOSITORY,
        "revision": revision,
        "base": base,
        "subsets": subsets,
        "files": [{"path": p, "bytes": sizes[p], "sha256": sums[p]} for p in paths],
    }
    # One file per line keeps a re-pin reviewable as a line diff.
    head = json.dumps({k: v for k, v in manifest.items() if k != "files"}, indent=2)
    lines = ",\n".join(
        "    " + json.dumps(entry, separators=(", ", ": "))
        for entry in manifest["files"]
    )
    with open(OUT, "w") as f:
        f.write(head[:-2] + ',\n  "files": [\n' + lines + "\n  ]\n}\n")
    for name, s in subsets.items():
        print(f"{name}: {s['files']} files, {s['bytes'] / 1e6:.1f} MB")
    print(
        f"{OUT}: {len(paths)} files, {sum(sizes.values()) / 1e6:.1f} MB at {revision[:12]}"
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
