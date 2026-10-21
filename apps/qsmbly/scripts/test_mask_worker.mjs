import assert from 'node:assert/strict';
import test from 'node:test';
import { MaskController } from '../js/controllers/MaskController.js';
import { WorkerSession } from '../../../packages/components/src/worker/WorkerSession.js';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';

for (const operation of ['applyMaskOps', 'hdBet']) {
  for (const fails of [false, true]) {
    test(`${operation} settles through the shared worker channel on ${fails ? 'error' : 'success'}`, async () => {
      const nativeWorker = {
        postMessage(message, transfer) {
          assert.equal(message.type, operation);
          structuredClone(message, { transfer });
          queueMicrotask(() => this.onmessage({ data: {
            type: `${operation}${fails ? 'Error' : 'Complete'}`,
            ...(fails ? { message: 'Kernel failed' } : { maskData: new Uint8Array([1]) }),
          } }));
        },
      };
      const session = new WorkerSession({ createWorker: () => nativeWorker });
      let initialized = false;
      let released = false;
      const controller = new MaskController({
        getWorker: () => session,
        initializeWorker: async () => {
          initialized = true;
          session.start();
        },
        beginCancellableJob: () => () => { released = true; },
        updateOutput() {},
        setProgress() {},
      });
      controller.maskDims = [1, 1, 1];
      controller.voxelSize = [1, 1, 1];
      controller.currentMaskData = new Uint8Array([1]);
      controller.ensureGeometry = () => true;
      controller.getSignalMagnitude = async () => new Float64Array([2]);
      controller.setThresholdSliderEnabled = () => {};
      const result = await (operation === 'applyMaskOps'
        ? controller.applyMaskOps('erode:1')
        : controller.runHdBetMask());
      assert.equal(result, !fails);
      assert.equal(initialized, true);
      assert.equal(session.listeners.size, 0);
      if (operation === 'hdBet') assert.equal(released, true);
    });
  }
}

for (const operation of ['biasCorrection', 'voxelQuality']) {
  for (const fails of [false, true]) {
    test(`${operation} uses the session channel and releases its response listener (${fails ? 'failure' : 'success'})`, async () => {
      let sentInput;
      const nativeWorker = {
        postMessage(message, transfer) {
          assert.equal(message.type, operation);
          sentInput = operation === 'biasCorrection' ? message.data.magnitude : message.data.phase;
          assert.deepEqual(Array.from(sentInput), [1]);
          structuredClone(message, { transfer });
          queueMicrotask(() => this.onmessage({ data: {
            type: operation,
            ...(fails ? { error: 'Scientific kernel failed' } : { result: new Float64Array([1, 2]) }),
          } }));
        },
      };
      const session = new WorkerSession({ createWorker: () => nativeWorker });
      const controller = new MaskController({
        getWorker: () => session,
        initializeWorker: async () => session.start(),
        setProgress() {},
      });
      const file = new File([syntheticNifti({ dims: [1, 1, 1], value: () => 1, gzip: false })], 'phase.nii');
      controller.magnitudeFileBytes = await file.arrayBuffer();
      const input = new Float64Array([1]);
      const promise = operation === 'biasCorrection'
        ? controller.applyBiasCorrection(input)
        : controller.computeVoxelQualityMap([{ file }], [], [4]);
      if (fails) await assert.rejects(promise, /Scientific kernel failed/);
      else assert.deepEqual(Array.from(await promise), [1, 2]);
      assert.equal(session.listeners.size, 0);
      // The input moves to the worker rather than being copied (astewartau/qsmbly#140).
      assert.equal(sentInput.byteLength, 0);
      if (operation === 'biasCorrection') assert.equal(sentInput, input);
    });
  }
}
