#!/usr/bin/env bash
# Synb0-DisCo, the sdc solver and the scores for every subject of the options document.
# Usage: run_all.sh [subject...]   (default: the six subjects)
# Needs ROOT, FS_LICENSE_FILE and SDC (see synb0.sh and solve.sh).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
subjects=("$@")
if [[ ${#subjects[@]} -eq 0 ]]; then
  subjects=(ds005134-sub-01 ds004146-sub-0001 ds004146-sub-0002 ds004146-sub-0003 ds004146-sub-0004 ds004146-sub-0005)
fi
for sub in "${subjects[@]}"; do
  [[ -f $ROOT/runs/$sub/synb0-topup/topup_fout.nii.gz ]] || bash "$here/synb0.sh" "$sub"
  bash "$here/solve.sh" "$sub"
  bash "$here/../dwi-reverse-pe-options/post.sh" "$sub" uncorrected synb0-topup synb0-sdc synb0-sdc-raw
  py() { "$ROOT/venv-main/bin/python" "$@"; }
  py "$here/compare.py" "$ROOT/runs/$sub" > "$ROOT/runs/$sub/synb0-compare.json"
done
