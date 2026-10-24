// Backend choice of `estimate`. The kernels themselves run in Chromium:
// apps/sdc/e2e/webgpu.spec.js (SwiftShader on CI, the sub-01 gate on a hardware adapter).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeGpuDevice, installGpuConstants } from "../../../test-utils/gpu-device.mjs";
import { loadSdc } from "../src/wasm.js";
import { isSoftwareAdapter, shaders } from "../src/webgpu.js";

const bytes = readFileSync(new URL("../src/sdc.wasm", import.meta.url));

function bumps([nx, ny, nz], shift) {
  const out = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const position = (y + 0.5) * 2 - shift;
        out[x + nx * (y + ny * z)] = 100 * Math.exp(-(((position - ny - z) / 6) ** 2)) + 5;
      }
    }
  }
  return out;
}

const dims = [6, 32, 4];
const pair = [bumps(dims, 2), bumps(dims, -2), dims, [2, 2, 2]];
const options = { phaseEncodingDirection: "j-", totalReadoutTime: 0.05 };

test("the cpu backend gives the numbers of pyhysco", async () => {
  const sdc = await loadSdc(bytes);
  const direct = sdc.pyhysco(...pair, options);
  const out = await sdc.estimate(...pair, { ...options, backend: "cpu" });
  assert.equal(out.backend, "cpu");
  assert.deepEqual(out.field, direct.field);
  assert.deepEqual(out.corrected1, direct.corrected1);
});

test("auto uses the CPU without a WebGPU adapter, and webgpu refuses to run without one", async () => {
  assert.equal(globalThis.navigator?.gpu, undefined, "Node has no WebGPU");
  const sdc = await loadSdc(bytes);
  const out = await sdc.estimate(...pair, options);
  assert.equal(out.backend, "cpu");
  assert.equal(out.gpuError, undefined);
  assert.deepEqual(out.field, sdc.pyhysco(...pair, options).field);
  await assert.rejects(sdc.estimate(...pair, { ...options, backend: "webgpu" }), /No WebGPU adapter|JSPI/);
  await assert.rejects(sdc.estimate(...pair, { ...options, backend: "metal" }), /backend must be auto, webgpu or cpu/);
});

test("a failing WebGPU run falls back to the CPU under auto and fails under webgpu", { skip: typeof WebAssembly.Suspending !== "function" && "needs JSPI" }, async () => {
  installGpuConstants();
  const sdc = await loadSdc(bytes);
  // The fake device has no compute passes: the first evaluation throws inside the WebAssembly.
  const device = fakeGpuDevice();
  const out = await sdc.estimate(...pair, { ...options, device });
  assert.equal(out.backend, "cpu");
  assert.match(out.gpuError, /beginComputePass/);
  assert.deepEqual(out.field, sdc.pyhysco(...pair, options).field, "the CPU instance is not poisoned");
  const again = await sdc.estimate(...pair, { ...options, device });
  assert.equal(again.backend, "cpu");
  await assert.rejects(sdc.estimate(...pair, { ...options, backend: "webgpu", device: fakeGpuDevice() }), /beginComputePass/);
  // Invalid input fails with the CPU path's message, not as a GPU failure.
  const constant = new Float64Array(pair[0].length).fill(1);
  await assert.rejects(sdc.estimate(constant, constant, dims, [2, 2, 2], { ...options, device: fakeGpuDevice() }), /refused the input/);
  await assert.rejects(sdc.estimate(...pair, { phaseEncodingDirection: "k", totalReadoutTime: 0.05, device: fakeGpuDevice() }), /must be i, i-, j or j-/);
});

test("auto does not pick a software adapter", () => {
  assert.ok(isSoftwareAdapter({ info: { vendor: "google", architecture: "swiftshader", isFallbackAdapter: true } }));
  assert.ok(isSoftwareAdapter({ info: { vendor: "mesa", description: "llvmpipe (LLVM 19.1.7, 256 bits)" } }));
  assert.ok(isSoftwareAdapter({ info: { vendor: "microsoft", description: "Microsoft Basic Render Driver" } }));
  assert.ok(!isSoftwareAdapter({ info: { vendor: "intel", architecture: "xe-2lpg" } }));
  assert.ok(!isSoftwareAdapter({ info: { vendor: "apple", architecture: "metal-3" } }));
});

test("every kernel binds its uniforms first and reduces only where it declares partials", () => {
  for (const [name, code] of Object.entries(shaders)) {
    assert.match(code, /@group\(0\) @binding\(0\) var<uniform> P: Params;/, name);
    assert.equal(/reduceTwo\(lid/.test(code), /var<storage, read_write> partials/.test(code), name);
  }
});
