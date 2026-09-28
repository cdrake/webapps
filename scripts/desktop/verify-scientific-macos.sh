#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This helper requires macOS with an Apple GPU. See SCIENTIFIC-VALIDATION.md for Linux CPU commands.' >&2
  exit 2
fi
stage="${1:-all}"
case "$stage" in native|webgpu|probe|extraction|all) ;; *) echo 'Usage: verify-scientific-macos.sh [native|webgpu|probe|extraction|all]' >&2; exit 2 ;; esac
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
: "${TMPDIR:?Set TMPDIR to a writable scratch volume.}"
validation="$(mktemp -d "${TMPDIR%/}/neurodesk-scientific.XXXXXX")"
export SYNTHSEG_REFERENCE_DIR="${SYNTHSEG_REFERENCE_DIR:-$validation/references}"
export SYNTHSEG_ASSET_DIR="$root/exes/synthseg/models"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$validation/native-target}"
export CI=1
printf '%s\n' "$validation" > "$validation/evidence-directory.txt"
git rev-parse HEAD > "$validation/commit.txt"
system_profiler SPHardwareDataType SPDisplaysDataType > "$validation/hardware.txt"
printf 'Evidence directory: %s\n' "$validation"

native_report='exes/synthseg/validation/report.json'
restore_native_report=0
original_native_report=0
finish() {
  local status=$?
  if [[ "$restore_native_report" == 1 ]]; then
    [[ ! -f "$native_report" ]] || cp "$native_report" "$validation/native-parity.json"
    if [[ "$original_native_report" == 1 ]]; then
      cp "$validation/native-report-before.json" "$native_report"
    else
      rm -f "$native_report"
    fi
  fi
  printf '%s\n' "$status" > "$validation/exit-code.txt"
  printf 'Evidence directory: %s (exit %s)\n' "$validation" "$status"
}
trap finish EXIT

if [[ "$stage" != extraction && "$stage" != probe ]]; then
  make -C exes/synthseg check-model fetch-validation 2>&1 | tee "$validation/assets.log"
fi
if [[ "$stage" == native || "$stage" == all ]]; then
  if [[ -f "$native_report" ]]; then
    cp "$native_report" "$validation/native-report-before.json"
    original_native_report=1
  fi
  restore_native_report=1
  rm -f "$native_report"
  SYNTHSEG_REAL_DEVICES=cpu,metal make -C exes/synthseg test test-real 2>&1 | tee "$validation/native.log"
  export NEURODESK_SYNTHSEG_BIN="$CARGO_TARGET_DIR/release/synthseg"
  NEURODESK_SCIENTIFIC_OUTPUT="$validation/native-automation" node scripts/desktop/native-scientific-smoke.mjs 2>&1 | tee "$validation/native-automation.log"
fi
if [[ "$stage" == webgpu || "$stage" == all ]]; then
  SYNTHSEG_E2E_FIXTURE=1 SYNTHSEG_HARDWARE_GPU=1 SYNTHSEG_VALIDATION_REPORT="$validation/webgpu.json" \
    pnpm --filter synthseg exec playwright test e2e/fixture.spec.js --headed 2>&1 | tee "$validation/webgpu.log"
fi
if [[ "$stage" == probe ]]; then
  SYNTHSEG_PROBE_ONLY=1 SYNTHSEG_HARDWARE_GPU=1 SYNTHSEG_VALIDATION_REPORT="$validation/webgpu-probe.json" \
    pnpm --filter synthseg exec playwright test e2e/fixture.spec.js --headed 2>&1 | tee "$validation/webgpu-probe.log"
fi
if [[ "$stage" == extraction || "$stage" == all ]]; then
  pnpm --filter brain-extraction build 2>&1 | tee "$validation/extraction-build.log"
  BRAIN_EXTRACTION_REAL_MODELS=1 PLAYWRIGHT_JSON_OUTPUT_NAME="$validation/extraction.json" \
    pnpm --filter brain-extraction exec playwright test --grep 'real model' --reporter=line,json 2>&1 | tee "$validation/extraction.log"
fi
