#!/usr/bin/env bash
# Build wasm/hmc-registration.{mjs,wasm}: ANTs antsRegistration (3D float only) at the ANTs commit and
# ITK-Wasm Emscripten image that packages/registration and packages/n4 pin. Docker, curl and tar are required.
#
#   bash packages/hmc-registration/scripts/build.sh /absolute/build/dir
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
build=${1:?Pass an absolute build directory outside the repository}
case "$build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
mkdir -p "$build"
commit=52bc0ab588102682587303d31c720de94e6ef6c1
toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
if [ ! -f "$build/ants-$commit/Examples/antsRegistration.cxx" ]; then
  if [ ! -f "$build/ants.tar.gz" ]; then
    curl --fail --location "https://codeload.github.com/ANTsX/ANTs/tar.gz/$commit" -o "$build/ants.tar.gz"
  fi
  mkdir -p "$build/ants-$commit"
  tar -xzf "$build/ants.tar.gz" --strip-components=1 -C "$build/ants-$commit"
fi
# One compile job; the container memory limit keeps a large ITK translation unit from exhausting the host.
# ANTsVersion.cxx embeds __DATE__ and __TIME__; SOURCE_DATE_EPOCH fixes them at the ANTs commit time
# (2025-06-10 18:33:01 UTC), so a rebuild writes the same bytes and the pinned SHA-256 holds.
docker run --rm --network none --memory "${HMC_REGISTRATION_BUILD_MEMORY:-8g}" --entrypoint bash \
  -e SOURCE_DATE_EPOCH=1749580381 \
  --name "${HMC_REGISTRATION_BUILD_NAME:-hmc-registration-build}" \
  -v "$build:/build" -v "$root/packages/hmc-registration:/source:ro" \
  "$toolchain" -c "emcmake cmake -S /source -B /build/wasm -DITK_DIR=/ITK-build -DANTS_SOURCE_DIR=/build/ants-$commit -DCMAKE_BUILD_TYPE=Release && cmake --build /build/wasm -j 1"
cp "$build/wasm/hmc-registration.mjs" "$build/wasm/hmc-registration.wasm" "$root/packages/hmc-registration/wasm/"
sha256sum "$root/packages/hmc-registration/wasm/hmc-registration.wasm"
