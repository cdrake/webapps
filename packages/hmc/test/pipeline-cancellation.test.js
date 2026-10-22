import assert from "node:assert/strict";
import test from "node:test";
import { correctHeadMotion, readSeries } from "../src/pipeline.js";
import { loadHmcNode } from "../src/node.js";
import { makeSeries } from "./synthetic.js";

async function skippedSeries(signal, gzip, onProgress) {
  const { nifti, bvals, bvecs } = makeSeries();
  return correctHeadMotion({
    series: await readSeries(nifti),
    bvals,
    bvecs,
    target: () => null,
    argv: () => assert.fail("a skipped volume needs no registration"),
    fileName: "sub-01_dwi.nii.gz",
    hmc: await loadHmcNode(),
    runtime: { workers: 1, spawn: () => assert.fail("a skipped series starts no workers"), gzip },
    signal,
    onProgress,
  });
}

test("an abort during compression rejects without publishing completed progress", async () => {
  const controller = new AbortController();
  const events = [];
  let beginCompression;
  const compressing = new Promise((resolve) => { beginCompression = resolve; });
  let finishCompression;
  const held = new Promise((resolve) => { finishCompression = resolve; });
  const run = skippedSeries(controller.signal, async () => {
    beginCompression();
    await held;
    return new Uint8Array([1]);
  }, (event) => events.push(event));
  await compressing;
  controller.abort();
  finishCompression();
  await assert.rejects(run, { name: "AbortError" });
  assert.deepEqual(events, [{ stage: "write", done: 0, total: 1 }]);
});

test("aborting in the write-start callback prevents compression", async () => {
  const controller = new AbortController();
  await assert.rejects(skippedSeries(controller.signal,
    () => assert.fail("compression must not begin after cancellation"),
    (event) => {
      assert.deepEqual(event, { stage: "write", done: 0, total: 1 });
      controller.abort();
    }), { name: "AbortError" });
});
