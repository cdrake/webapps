/*
 * SCT segmentation of one image, shared by the browser worker and the sct-webapp
 * command line: input preparation, task preprocessing, sliding-window inference,
 * post-processing (TotalSpineSeg discs, region masks, lesion metrics) and the
 * NIfTI outputs. The caller owns the ONNX Runtime session, so this module never
 * fetches, caches or touches a browser global.
 */
import { prepareRasWorkerInput } from '@neurodesk/webapp-components/worker';
import { createNiftiFromData, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import {
  flipVolumeAxes,
  inverseOrient,
  resampleLabelsNearest,
  resampleVolume,
  transposeXYZToZYX,
  transposeZYXToXYZ,
} from '@neurodesk/webapp-components/volume';
import {
  runInferencePipeline,
  runMulticlassInferencePipeline,
  runRegionInferencePipeline,
  runSigmoidLabelInferencePipeline,
} from './inference-pipeline.js';
import { analyzeLesions } from './lesion-analysis.js';
import { postprocessStep1 } from './totalspineseg.js';

function channels(events) {
  return {
    postLog: (message) => events.log?.(message),
    postAnalysis: (message, level = 'info') => events.analysis?.(message, level),
    postProgress: (value, message) => events.progress?.(value, message),
  };
}

/**
 * Parse a NIfTI file and orient it to RAS. `decompress` gunzips (pako in the
 * browser, zlib in Node).
 */
export function prepareInput(inputData, { decompress, events = {} } = {}) {
  const { postLog, postAnalysis, postProgress } = channels(events);
  postLog('Parsing input volume...');
  postProgress(0.02, 'Reading NIfTI...');
  const prepared = prepareRasWorkerInput(parseNiftiVolume(inputData, { decompress }));
  postAnalysis(`Input volume: ${prepared.origDims.join('x')}, spacing: ${prepared.rasSpacing.map(value => value.toFixed(3)).join('x')}mm`);
  postLog(`RAS dims: ${prepared.rasDims.join('x')}`);
  return prepared;
}

export function orientationFlipAxesFromRAS(modelOrientation) {
  if (!modelOrientation || modelOrientation === 'RAS') return [];
  if (modelOrientation === 'RPI') return [1, 2];
  if (modelOrientation === 'LPI') return [0, 1, 2];
  throw new Error(`Unsupported modelOrientation "${modelOrientation}"`);
}

export function shouldUseZYXModelAxisOrder(preprocessing, dims, patchSize) {
  const modelAxisOrder = preprocessing?.modelAxisOrder;
  if (modelAxisOrder === 'zyx') return true;
  if (modelAxisOrder !== 'zyx-if-x-short-z-long') return false;

  const [nx, , nz] = dims;
  const [px] = Array.isArray(patchSize) ? patchSize : [];
  return Number.isFinite(px) && nx < px && nz >= px;
}

function formatChannelStats(stats, { withAbove = true } = {}) {
  return stats.channels.map(channel => (
    `c${channel.channel}: logit=[${channel.oMin.toFixed(3)},${channel.oMax.toFixed(3)}], prob=[${channel.pMin.toFixed(4)},${channel.pMax.toFixed(4)}] mean=${channel.pMean.toFixed(4)}${withAbove ? `, n>thr=${channel.pAbove}` : ''}`
  )).join('; ');
}

/**
 * Segment a prepared image with one SCT task.
 *
 * `params` is the worker's `run-inference` message: task id, model settings
 * from the task inventory and the user's threshold, component size and TTA.
 * `runtime.ort` provides `Tensor`; `runtime.session` is an ONNX Runtime
 * InferenceSession for the task's model, released here when inference ends.
 * Each output is handed to `events.stage` as soon as it exists and returned.
 */
export async function segmentPrepared(prepared, params, { ort, session, events = {} }) {
  const { postLog, postAnalysis, postProgress } = channels(events);
  const {
    overlap = 0,
    threshold = 0.1,
    minComponentSize = 10,
    keepLargestComponent = false,
    taskId = 'spinalcord',
    patchSize = [64, 64, 64],
    testTimeAugmentation = false,
    preprocessing = {},
    output = {}
  } = params;

  const results = [];
  let segmentationState = null;
  const emit = (result) => {
    const stageResult = { ...result, taskId };
    results.push(stageResult);
    events.stage?.(stageResult);
  };

  // Result summary for the analysis log. Returns the labelled voxel count.
  const postMaskSummary = (stage, labels) => {
    const seen = new Set();
    let voxels = 0;
    let last = 0;
    for (let i = 0; i < labels.length; i++) {
      const value = labels[i];
      if (value > 0) {
        voxels++;
        if (value !== last) seen.add(value);
      }
      last = value;
    }
    const [dx, dy, dz] = prepared.rasSpacing || [1, 1, 1];
    const labelText = seen.size > 1 ? `${seen.size} labels, ` : '';
    postAnalysis(`${stage}: ${labelText}${voxels} voxels (${(voxels * dx * dy * dz).toFixed(1)} mm^3)`);
    return voxels;
  };

  // RAS labels back to the input's voxel order, as a uint8 NIfTI with its header.
  const toOutputLabels = (labels) => (prepared.isIdentity
    ? labels
    : inverseOrient(labels, prepared.rasDims, prepared.perm, prepared.flip, prepared.origDims));
  const emitMask = (stage, outputLabels, description) => {
    const niftiData = createNiftiFromData(outputLabels, prepared.origHeaderBytes, { dims: prepared.origDims });
    emit({ kind: 'nifti', stage, niftiData, description });
  };

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const inferenceStartTime = performance.now();
  let modelInputData = new Float32Array(prepared.rasData);
  let modelInputDims = [...prepared.rasDims];
  let modelOutputToRas = (labels, dims, OutputCtor) => ({ data: labels, dims, ctor: OutputCtor || Uint8Array });

  const targetSpacing = Array.isArray(preprocessing.targetSpacing)
    ? preprocessing.targetSpacing.map((value, index) => value == null ? prepared.rasSpacing[index] : Number(value))
    : null;
  if (targetSpacing) {
    const resampled = resampleVolume(modelInputData, modelInputDims, prepared.rasSpacing, targetSpacing);
    const spacingText = targetSpacing.map(v => v.toFixed(3)).join('x');
    const modelOrderSpacing = preprocessing.modelAxisOrder === 'zyx'
      ? [targetSpacing[2], targetSpacing[1], targetSpacing[0]]
      : targetSpacing;
    const modelOrderText = modelOrderSpacing.map(v => v.toFixed(3)).join('x');
    postLog(`Resampled for ${taskId}: ${modelInputDims.join('x')} -> ${resampled.dims.join('x')} at ${spacingText} mm RAS/XYZ (model order ${modelOrderText} mm)`);
    modelInputData = resampled.data;
    modelInputDims = resampled.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restored = previousOutputToRas(labels, dims, OutputCtor);
      return {
        data: resampleLabelsNearest(restored.data, restored.dims, prepared.rasDims),
        dims: [...prepared.rasDims],
        ctor: OutputCtor || Uint8Array
      };
    };
  }

  const modelOrientationFlipAxes = orientationFlipAxesFromRAS(preprocessing.modelOrientation);
  if (modelOrientationFlipAxes.length > 0) {
    const oriented = flipVolumeAxes(modelInputData, modelInputDims, modelOrientationFlipAxes, Float32Array);
    postLog(`Reoriented for ${taskId}: RAS -> ${preprocessing.modelOrientation}`);
    modelInputData = oriented.data;
    modelInputDims = oriented.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restored = flipVolumeAxes(labels, dims, modelOrientationFlipAxes, OutputCtor || Uint8Array);
      return previousOutputToRas(restored.data, restored.dims, OutputCtor || Uint8Array);
    };
  }

  if (shouldUseZYXModelAxisOrder(preprocessing, modelInputDims, patchSize)) {
    const transposed = transposeXYZToZYX(modelInputData, modelInputDims, Float32Array);
    postLog(`Reordered for ${taskId}: ${modelInputDims.join('x')} xyz -> ${transposed.dims.join('x')} zyx`);
    modelInputData = transposed.data;
    modelInputDims = transposed.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restoredAxes = transposeZYXToXYZ(labels, dims, OutputCtor || Uint8Array);
      return previousOutputToRas(restoredAxes.data, restoredAxes.dims, OutputCtor || Uint8Array);
    };
  }

  const runPatch = async (patch, patchDims) => {
    const [p0, p1, p2] = patchDims;
    const inputTensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
    const out = await session.run({ [inputName]: inputTensor });
    const logits = out[outputName].data;
    inputTensor.dispose();
    return logits;
  };

  const progressHandler = (stepsDone, totalSteps, label) => {
    const elapsed = (performance.now() - inferenceStartTime) / 1000;
    const eta = stepsDone > 0 ? (elapsed / stepsDone) * (totalSteps - stepsDone) : 0;
    const frac = totalSteps > 0 ? stepsDone / totalSteps : 0;
    postProgress(0.25 + 0.55 * frac, `${label} (ETA: ${eta.toFixed(0)}s)`);
  };
  const volume = { data: modelInputData, dims: modelInputDims, patchSize };
  const finishInference = async () => {
    await session.release();
    postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);
    postProgress(0.86, 'Inverse transform...');
  };

  // Label models (sigmoid labels, softmax): one segmentation, or TotalSpineSeg's two stages.
  const emitLabelOutputs = (rawRAS, description) => {
    if (output.postprocess === 'totalspineseg-step1') {
      postProgress(0.90, 'Labeling TotalSpineSeg discs...');
      const processed = postprocessStep1(rawRAS.data, rawRAS.dims, {
        discPointRadius: output.discPointRadius
      });
      for (const warning of processed.warnings) postAnalysis(`TotalSpineSeg warning: ${warning}`, 'warning');

      const stages = [
        {
          stage: 'spine_step1',
          labels: processed.step1Labels,
          description: 'TotalSpineSeg step 1 labels'
        },
        {
          stage: 'spine_discs',
          labels: processed.discLabels,
          description: 'TotalSpineSeg disc labels'
        }
      ];

      for (const stageOutput of stages) {
        const outputLabels = toOutputLabels(stageOutput.labels);
        emitMask(stageOutput.stage, outputLabels, stageOutput.description);
        postMaskSummary(stageOutput.stage, outputLabels);
      }
      return;
    }
    const outputLabels = toOutputLabels(rawRAS.data);
    emitMask('segmentation', outputLabels, description);
    postMaskSummary('segmentation', outputLabels);
  };

  if (output.activation === 'sigmoid-regions') {
    const regions = Array.isArray(output.regions) ? output.regions : [];
    const channelCount = output.channelCount || output.channelOrder?.length || regions.length || 1;
    const result = await runRegionInferencePipeline(volume, runPatch, {
      overlap,
      threshold,
      minComponentSize,
      testTimeAugmentation,
      channelCount,
      regions,
      paddingMode: output.paddingMode,
      gaussianSigmaScale: output.gaussianSigmaScale,
      onLog: (msg) => postLog(msg),
      onProgress: progressHandler,
      onPatchStats: (pi, s) => {
        postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${formatChannelStats(s)}`);
      }
    });
    await finishInference();

    let spinalCordRAS = null;
    let lesionRAS = null;
    for (const region of result.regions) {
      const stage = region.stage || region.name || `channel_${region.channel}`;
      const description = region.description || (stage === 'lesion' ? 'Lesion segmentation' : 'SCT segmentation');
      const preCleanupRAS = modelOutputToRas(region.preCleanupLabels, region.dims, Uint8Array);
      const outputRAS = modelOutputToRas(region.labels, region.dims, Uint8Array);
      if (stage === 'segmentation') {
        segmentationState = { segLabelsRAS: new Uint8Array(preCleanupRAS.data), segMinComponentSize: minComponentSize };
        spinalCordRAS = new Uint8Array(outputRAS.data);
      }
      if (stage === 'lesion') lesionRAS = new Uint8Array(outputRAS.data);

      const outputLabels = toOutputLabels(new Uint8Array(outputRAS.data));
      emitMask(stage, outputLabels, description);

      const finalVoxels = postMaskSummary(stage, outputLabels);
      if (finalVoxels === 0) {
        const stats = region.probStats;
        postAnalysis(`WARNING: ${stage} mask is empty. Probability map max=${stats?.max?.toFixed?.(4) || 'n/a'} (threshold=${region.threshold}).`, 'warning');
      }
    }

    if (segmentationState) events.segmentationState?.(segmentationState);

    // A model that segments the cord as well gets cord-relative metrics. A
    // lesion-only model (lesion_ms) opts in through output.metricsStage and gets
    // lesion geometry only, with the cord-relative columns left empty.
    const metricsStage = output.metricsStage || 'lesion_metrics';
    if (lesionRAS && (spinalCordRAS || output.metricsStage)) {
      postProgress(0.94, 'Computing lesion metrics...');
      const metrics = analyzeLesions({
        lesion: lesionRAS,
        spinalCord: spinalCordRAS,
        dims: prepared.rasDims,
        spacing: prepared.rasSpacing
      });
      emit({
        kind: 'metrics',
        stage: metricsStage,
        rows: metrics.rows || [],
        summary: metrics.summary || null,
        csv: metrics.csv || '',
        filename: `${taskId}_lesion_metrics.csv`,
        description: 'Lesion metrics'
      });
      postAnalysis(`Lesion metrics: ${metrics.summary.lesion_count} lesion(s), total volume=${metrics.summary.total_volume_mm3} mm^3`);
    }
  } else if (output.activation === 'sigmoid-labels') {
    const channelCount = output.channelCount || output.channelOrder?.length || output.classLabels?.length || 1;
    const result = await runSigmoidLabelInferencePipeline(volume, runPatch, {
      overlap,
      threshold,
      testTimeAugmentation,
      channelCount,
      classLabels: output.classLabels,
      labelPriority: output.labelPriority,
      paddingMode: output.paddingMode,
      onLog: (msg) => postLog(msg),
      onProgress: progressHandler,
      onPatchStats: (pi, s) => {
        postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${formatChannelStats(s)}`);
      }
    });
    await finishInference();
    emitLabelOutputs(modelOutputToRas(result.labels, result.dims, Uint8Array), 'SCT sigmoid-label segmentation');
  } else if (output.activation === 'softmax') {
    const channelCount = output.channelCount || output.channelOrder?.length || output.classLabels?.length || 1;
    const result = await runMulticlassInferencePipeline(volume, runPatch, {
      overlap,
      testTimeAugmentation,
      channelCount,
      classLabels: output.classLabels,
      paddingMode: output.paddingMode,
      onLog: (msg) => postLog(msg),
      onProgress: progressHandler,
      onPatchStats: (pi, s) => {
        postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${formatChannelStats(s, { withAbove: false })}`);
      }
    });
    await finishInference();
    emitLabelOutputs(modelOutputToRas(result.labels, result.dims, Uint8Array), 'SCT multiclass segmentation');
  } else {
    const result = await runInferencePipeline(volume, runPatch, {
      overlap, threshold, minComponentSize, keepLargestComponent, testTimeAugmentation,
      onLog: (msg) => postLog(msg),
      onProgress: progressHandler,
      onPatchStats: (pi, s) => {
        postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}, logit=[${s.oMin.toFixed(3)},${s.oMax.toFixed(3)}], prob=[${s.pMin.toFixed(4)},${s.pMax.toFixed(4)}] mean=${s.pMean.toFixed(4)}, n>thr=${s.pAbove}`);
      }
    });
    await finishInference();

    // Keep the unmasked (pre-CC) labels for downstream browser processing.
    const preCleanupRAS = modelOutputToRas(result.preCleanupLabels, result.dims, Uint8Array);
    segmentationState = { segLabelsRAS: new Uint8Array(preCleanupRAS.data), segMinComponentSize: minComponentSize };
    events.segmentationState?.(segmentationState);

    const outputLabels = toOutputLabels(modelOutputToRas(result.labels, result.dims, Uint8Array).data);
    emitMask('segmentation', outputLabels, 'SCT segmentation');

    const finalVoxels = postMaskSummary('segmentation', outputLabels);
    if (finalVoxels === 0) {
      postAnalysis(`WARNING: Segmentation is empty. Probability map max=${result.probStats.max.toFixed(4)} (threshold=${threshold}). Try lowering the probability threshold or check input contrast/orientation.`, 'warning');
    }
  }

  postProgress(1.0, 'Complete');
  return { results, segmentationState };
}
