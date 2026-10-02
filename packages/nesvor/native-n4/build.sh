#!/usr/bin/env bash
set -euo pipefail
n4_source=$(cd "$(dirname "$0")" && pwd)
n4_build=${1:?Pass an absolute build directory outside the repository}
case "$n4_build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
n4_repo=$(cd "$n4_source/../../.." && pwd)
n4_build=$(realpath -m "$n4_build")
case "$n4_build/" in "$n4_repo/"*) echo 'Build directory must be outside the repository' >&2; exit 1;; esac
mkdir -p "$n4_build"
n4_toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
${DOCKER:-docker} run --rm --network none --entrypoint bash \
  -v "$n4_build:/build" -v "$n4_source:/source:ro" \
  "$n4_toolchain" -c 'emcmake cmake -S /source -B /build -DITK_DIR=/ITK-build -DCMAKE_BUILD_TYPE=Release && cmake --build /build -j 1'
sha256sum "$n4_build/nesvor-n4.mjs" "$n4_build/nesvor-n4.wasm"
