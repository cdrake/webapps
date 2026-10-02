import { writeVolume } from '../../synthsr/src/volume.js';
import { browserConfig } from './config.js';
import { decodeStacks, prepareTraining } from './input.js';
import { preprocessStacks } from './preprocessing/index.js';
import { segmentStacks } from './masking/index.js';
import { createDeformationModel } from './deformation/model.js';
import { createGPUDeformation } from './deformation/gpu.js';
import { registerStacks } from './registration/index.js';
import { ReferenceNeSVoR } from './training/index.js';
import { fitGPU } from './training/gpu-fit.js';
import { poseMatrices } from './training/batch-objective.js';
import { createGPUField } from './gpu/field.js';
import { buildSupportMask, resampleSupportMask, sampleMaskedVolume } from './output/index.js';

export async function reconstructBrowser(request, { device, learnedStep, inferMask, correctBiasField, signal, onProgress = () => {} } = {}) {
  const config = browserConfig(request);
  signal?.throwIfAborted();
  const ownsDevice = !device;
  if (!device) {
    const adapter = await globalThis.navigator?.gpu?.requestAdapter();
    if (!adapter) throw new Error('Browser reconstruction requires WebGPU. Use a supported browser and GPU.');
    device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
  }
  let field;
  let deformation;
  try {
    onProgress({ stage: 'preparing', fraction: 0 });
    let stacks = decodeStacks(request.stacks);
    stacks = (await preprocessStacks(stacks, { ...request.options, normalize: false, signal })).stacks;
    if (request.options?.segmentation) {
      if (!inferMask) throw new Error('Automatic brain masking requires the pinned MONAIfbs model.');
      stacks = await segmentStacks(stacks, { infer: inferMask, signal, onProgress });
      await inferMask.release?.();
    }
    if (request.options?.biasFieldCorrection) {
      if (!correctBiasField) throw new Error('Bias correction requires the pinned N4 runtime.');
      for (let i = 0; i < stacks.length; i++) {
        signal?.throwIfAborted();
        onProgress({ stage: 'bias-correction', completed: i, total: stacks.length });
        stacks[i] = { ...stacks[i], data: await correctBiasField(stacks[i]) };
        onProgress({ stage: 'bias-correction', completed: i + 1, total: stacks.length });
      }
    }
    let registration = { mode: 'none' };
    if (config.registration !== 'none') {
      const result = await registerStacks(stacks, { mode: config.registration, learnedStep, signal, onProgress });
      stacks = result.stacks;
      registration = result.registration;
    }
    await learnedStep?.release?.();
    onProgress({ stage: 'training-setup' });
    const prepared = prepareTraining(stacks);
    const { observations, center, resolutions } = prepared;
    const model = new ReferenceNeSVoR({ ...config, boundingBox: prepared.boundingBox, poses: prepared.poses, mean: prepared.mean });
    field = await createGPUField(device, model, { microbatchSize: 1024 });
    if (config.deformable) {
      const deformationModel = createDeformationModel({ boundingBox: prepared.boundingBox, slices: model.slices, log2Size: config.log2Size, width: config.width, spatialScaling: config.spatialScaling });
      deformation = await createGPUDeformation(device, deformationModel);
    }
    await fitGPU(model, field, observations, { deformation, signal, onProgress: (progress) => onProgress({ stage: 'training', ...progress, fraction: 0.05 + 0.8 * (progress.step ?? (progress.iteration - 1 + progress.completed / progress.total)) / progress.iterations }) });
    signal?.throwIfAborted();
    onProgress({ stage: 'support-mask', fraction: 0.85 });
    const matrices = poseMatrices(model);
    const points = new Float32Array(observations.length * 3);
    observations.forEach((observation, index) => {
      const { slice, xyz } = observation;
      const local = xyz.map((v, i) => v + model.poses.values[slice * 6 + i + 3]);
      const { matrix } = matrices[slice];
      for (let axis = 0; axis < 3; axis++) points[index * 3 + axis] = center[axis] + config.spatialScaling * local.reduce((v, x, i) => v + matrix[axis * 3 + i] * x, 0);
    });
    const support = await buildSupportMask(points, resolutions, { signal });
    const grid = await resampleSupportMask(support, config.outputResolution, { signal });
    const volume = await sampleMaskedVolume(grid, async (world) => {
      const xyz = Float32Array.from(world, (value, i) => (value - center[i % 3]) / config.spatialScaling);
      return (await field.forward({ xyz, sliceIndices: new Uint32Array(xyz.length / 3) })).density;
    }, { psfResolution: config.outputResolution, nSamples: 2 * config.samples, signal, batchSize: 32, onProgress: ({ completed, total }) => onProgress({ stage: 'sampling', completed, total, fraction: 0.9 + 0.1 * completed / total }) });
    let sum = 0;
    let count = 0;
    volume.data.forEach((value, i) => { if (volume.mask[i]) { sum += value; count++; } });
    if (!(sum > 0) || !count) throw new Error('Reconstruction contains no positive supported output.');
    const intensityScale = 700 * count / sum;
    volume.data.forEach((value, i) => { volume.data[i] = value * intensityScale; });
    const provenance = { schema: 1, engine: 'browser-webgpu', sourceCommit: '730ddaa3711a2304386de34193ea4b957892fe7b', validated: false, registration, config, preprocessing: { segmentation: Boolean(request.options?.segmentation), biasFieldCorrection: Boolean(request.options?.biasFieldCorrection), otsuThresholding: Boolean(request.options?.otsuThresholding), stacksIntersection: Boolean(request.options?.stacksIntersection) }, precision: 'float32', hashLayout: 'upstream-pytorch', observations: observations.length, slices: model.slices, outputAffine: volume.affine, outputIntensityMean: 700, outputSamples: 2 * config.samples, limitations: ['Clinical-volume validation and CUDA numerical comparison remain outstanding.'] };
    onProgress({ stage: 'complete', fraction: 1 });
    return { volume: writeVolume(volume, 'NeSVoR WebGPU; experimental, unvalidated'), provenance, log: `WebGPU reconstruction completed: ${config.iterations} updates, ${observations.length} observations, ${volume.data.length} output voxels. Examination data stayed in the browser.` };
  } finally {
    deformation?.dispose();
    field?.dispose();
    if (ownsDevice) device.destroy();
  }
}
