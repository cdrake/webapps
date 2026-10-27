import { createNiftiFromData, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { connectedComponents3D, cOrderToNifti, niftiToCOrder, zScoreNormalize, cropCenteredVolume, padVolumeCentered } from '@neurodesk/webapp-components/volume';
import { V2_PLAN, resolveFolds, resolveModels, validateSelection } from './assets.js';
import * as nn from './nnunet.js';

function findPaddedDims(dims, factor) {
  return dims.map(d => Math.ceil(d / factor) * factor);
}


function softmaxExtractClass1(rawOutput, voxelCount, numClasses) {
  const result = new Float32Array(voxelCount);

  for (let v = 0; v < voxelCount; v++) {
    let maxLogit = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const logit = rawOutput[c * voxelCount + v];
      if (logit > maxLogit) maxLogit = logit;
    }

    let sumExp = 0;
    for (let c = 0; c < numClasses; c++) {
      sumExp += Math.exp(rawOutput[c * voxelCount + v] - maxLogit);
    }

    result[v] = Math.exp(rawOutput[1 * voxelCount + v] - maxLogit) / sumExp;
  }

  return result;
}

function selectTopNMarkers(probabilityMap, dims, nMarkers, threshold) {
  const n = probabilityMap.length;

  const binaryMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    binaryMask[i] = probabilityMap[i] > threshold ? 1 : 0;
  }

  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);

  if (numComponents === 0) return new Float32Array(n);

  if (numComponents <= nMarkers) {
    const result = new Float32Array(n);
    for (let i = 0; i < n; i++) result[i] = labels[i] > 0 ? 1.0 : 0.0;
    return result;
  }

  const componentSum = new Float64Array(numComponents + 1);
  const componentCount = new Int32Array(numComponents + 1);

  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) {
      componentSum[labels[i]] += probabilityMap[i];
      componentCount[labels[i]]++;
    }
  }

  const scores = [];
  for (let c = 1; c <= numComponents; c++) {
    scores.push({ label: c, meanProb: componentSum[c] / componentCount[c] });
  }
  scores.sort((a, b) => b.meanProb - a.meanProb);

  const keepLabels = new Set();
  for (let i = 0; i < Math.min(nMarkers, scores.length); i++) {
    keepLabels.add(scores[i].label);
  }

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = keepLabels.has(labels[i]) ? 1.0 : 0.0;
  }
  return result;
}

function averageProbabilityMaps(maps) {
  const n = maps[0].length;
  const result = new Float32Array(n);
  for (let m = 0; m < maps.length; m++) {
    const map = maps[m];
    for (let i = 0; i < n; i++) result[i] += map[i];
  }
  const count = maps.length;
  for (let i = 0; i < n; i++) result[i] /= count;
  return result;
}

/** v1 (legacy): consensus of the four 3D U-Nets. */
export async function runLegacyInference(inputData, { selectedModels, threshold = 0.1, nMarkers = 3, Tensor, createSession, qsm, loadModel, decompress, events = {} }) {
  const models = resolveModels(selectedModels);
  validateSelection({ threshold, nMarkers });
  const postLog = events.log || (() => {});
  const postProgress = events.progress || (() => {});
  const stages = {};
  const postStageData = (stage, niftiData, description) => {
    stages[stage] = { niftiData, description };
    events.stageData?.(stage, niftiData, description);
  };
  // 1. Parse NIfTI input
  postLog('Parsing input volume...');
  postProgress(0.02, 'Reading NIfTI...');
  const { imageData, dims, voxelSize, headerBytes } = parseNiftiVolume(inputData, { decompress });
  const [nx, ny, nz] = dims;
  const [vx, vy, vz] = voxelSize;
  postLog(`Volume dimensions: ${nx} x ${ny} x ${nz}, voxel: ${vx.toFixed(2)} x ${vy.toFixed(2)} x ${vz.toFixed(2)}mm`);

  // 2. Bias field correction (makehomogeneous)
  postProgress(0.05, 'Bias field correction...');
  postLog('Running bias field correction...');
  const mag64 = new Float64Array(imageData);
  const corrected64 = qsm.makehomogeneous_wasm(mag64, nx, ny, nz, vx, vy, vz, 7.0, 15);
  const correctedData = new Float32Array(corrected64);
  postLog('Bias field correction complete');

  // 3. Pad, normalize, and transpose to C-contiguous for ONNX
  postProgress(0.10, 'Normalizing...');
  const paddedDims = findPaddedDims(dims, 32);
  const paddedData = padVolumeCentered(correctedData, dims, paddedDims);
  const normalizedData = zScoreNormalize(paddedData);
  const [pnx, pny, pnz] = paddedDims;
  const tensorData = niftiToCOrder(normalizedData, [pnx, pny, pnz]);
  postLog(`Padded to: ${pnx} x ${pny} x ${pnz}`);

  // 4. Run each model
  const allProbMaps = [];
  const totalModels = models.length;

  for (let i = 0; i < totalModels; i++) {
    const asset = models[i];
    const modelName = asset.filename;
    const perModelSpan = 0.65 / totalModels;
    const progressBase = 0.15 + i * perModelSpan;
    const dlSpan = perModelSpan * 0.6;   // 60% of per-model span for download
    const runBase = progressBase + dlSpan; // remaining 40% for inference

    // Fetch model (with download progress)
    const modelData = await loadModel(asset, modelName, progressBase, dlSpan);

    // Create ONNX session
    postProgress(runBase, `Loading model ${i + 1}/${totalModels}...`);
    postLog('Creating ONNX InferenceSession...');
    let session;
    try {
      session = await createSession(modelData);
    } catch (e) {
      postLog(`Session creation failed: ${e?.message || String(e)}`);
      throw e;
    }
    postLog(`Session created. Inputs: ${session.inputNames}, Outputs: ${session.outputNames}`);

    // Create input tensor [1, 1, nx, ny, nz] — C-contiguous
    postProgress(runBase + perModelSpan * 0.2, `Running model ${i + 1}/${totalModels}...`);
    const inputTensor = new Tensor(
      'float32',
      tensorData,
      [1, 1, pnx, pny, pnz]
    );

    // Run inference
    postLog('Running inference...');
    const inputName = session.inputNames[0];
    try {
      let results;
      try {
        results = await session.run({ [inputName]: inputTensor });
      } catch (e) {
        postLog(`Inference run failed: ${e?.message || String(e)}`);
        throw e;
      }
      const outputName = session.outputNames[0];
      const rawOutput = results[outputName].data;

      // Softmax and extract class 1 probability (output is C-contiguous)
      const voxelCount = pnx * pny * pnz;
      const probMapC = softmaxExtractClass1(rawOutput, voxelCount, 3);

      // Transpose output back to NIfTI order, then crop
      const probMapNifti = cOrderToNifti(probMapC, [pnx, pny, pnz]);
      const croppedProb = cropCenteredVolume(probMapNifti, paddedDims, dims);
      allProbMaps.push(croppedProb);

      // Send individual model result as NIfTI
      const modelNifti = createNiftiFromData(croppedProb, headerBytes);
      postStageData(`model${i + 1}`, modelNifti, `Model ${i + 1} seed probability`);

    } finally {
      inputTensor.dispose();
      await session.release();
    }

    postLog(`Model ${i + 1}/${totalModels} complete`);
  }

  // 5. Average probability maps
  postProgress(0.85, 'Computing consensus...');
  const avgProb = averageProbabilityMaps(allProbMaps);
  const avgNifti = createNiftiFromData(avgProb, headerBytes);
  postStageData('avgProb', avgNifti, 'Average probability');

  // 6. Connected component labeling + top-N selection
  postProgress(0.92, 'Selecting markers...');
  const consensusMask = selectTopNMarkers(avgProb, dims, nMarkers, threshold);
  const consensusNifti = createNiftiFromData(consensusMask, headerBytes);
  postStageData('consensus', consensusNifti, 'Consensus segmentation');

  // Count marker voxels
  let markerVoxels = 0;
  for (let i = 0; i < consensusMask.length; i++) {
    if (consensusMask[i] > 0) markerVoxels++;
  }
  postLog(`Consensus: ${markerVoxels} voxels in final segmentation`);

  postProgress(1.0, 'Complete');
  return { model: 'v1', stages, markerVoxels, dims, models: models.map(({ id, sha256 }) => ({ id, sha256 })) };
}

const errorMessage = error => error?.message || String(error);

/**
 * v2: nnU-Net v2 (ResEnc) fold ensemble, following upstream scripts/deploy/seedseg_onnx.py:
 * bias field correction -> crop to nonzero -> z-score -> [resample] -> Gaussian sliding window
 * (optional test-time mirroring) per network -> softmax -> mean over networks -> candidates
 * (components of p > threshold, ranked by mean probability) -> top K markers + count flag.
 * Each network's session exists only while that network runs, so memory holds one at a time.
 * `backends` are tried in order per network; a failure falls back to the next one.
 */
export async function runNetworkInference(inputData, { folds, mirror = false, threshold = 0.1, nMarkers = 3,
  backends = ['wasm'], Tensor, createSession, qsm, loadModel, decompress, events = {} }) {
  const networks = resolveFolds(folds);
  validateSelection({ threshold, nMarkers });
  if (typeof mirror !== 'boolean') throw new Error('Mirroring must be true or false.');
  const plan = V2_PLAN;
  const postLog = events.log || (() => {});
  const postProgress = events.progress || (() => {});
  const stages = {};
  const postStageData = (stage, niftiData, description) => {
    stages[stage] = { niftiData, description };
    events.stageData?.(stage, niftiData, description);
  };
  const started = performance.now();
  const timing = { folds: [] };

  postProgress(0.02, 'Reading NIfTI...');
  const { imageData, dims: niftiDims, voxelSize, headerBytes, affine } = parseNiftiVolume(inputData, { decompress });
  const [nx, ny, nz] = niftiDims;
  const [vx, vy, vz] = voxelSize;
  const dims = [nz, ny, nx];
  const spacing = [vz, vy, vx];
  postLog(`Volume ${nx} x ${ny} x ${nz}, voxel ${voxelSize.map(v => v.toFixed(3)).join(' x ')} mm`);

  // 1. Bias field correction. The training images were N4-corrected; N4 is not available in
  // the browser, so makehomogeneous (QSM.rs) is used instead, as upstream does.
  postProgress(0.04, 'Bias field correction...');
  let t = performance.now();
  const vol = new Float32Array(qsm.makehomogeneous_wasm(new Float64Array(imageData), nx, ny, nz, vx, vy, vz, 7.0, 15));
  timing.biasCorrection = (performance.now() - t) / 1000;
  postLog(`Bias field correction (makehomogeneous): ${timing.biasCorrection.toFixed(1)} s`);

  // 2. nnU-Net preprocessing: crop to nonzero, z-score, resample if needed, pad to patch.
  const patch = plan.patch_size;
  const box = nn.nonzeroBBox(vol, dims);
  const cropped = nn.cropBox(vol, dims, box);
  nn.zscoreInPlace(cropped.data);
  let work = cropped.data;
  let workDims = cropped.dims;
  const resampledDims = nn.newShape(workDims, spacing, plan.spacing_zyx);
  const resampled = resampledDims.some((n, i) => n !== workDims[i]);
  if (resampled) {
    postLog(`Warning: spacing ${spacing.join('x')} differs from the training spacing ${plan.spacing_zyx.join('x')}; `
      + `resampling ${workDims.join('x')} -> ${resampledDims.join('x')} (linear)`);
    work = nn.resampleLinear(work, workDims, resampledDims);
    workDims = resampledDims;
  }
  const padded = nn.padToPatch(work, workDims, patch);
  const gaussian = nn.gaussianMap(patch, plan.gaussian.sigma_scale, plan.gaussian.value_scaling_factor);
  const mirrorAxes = mirror ? plan.mirror_axes : [];
  const steps = nn.windowSteps(padded.dims, patch, plan.tile_step_size);
  const tiles = steps[0].length * steps[1].length * steps[2].length;
  postLog(`Sliding window: ${tiles} patches x ${nn.mirrorSets(mirrorAxes).length} mirrorings x ${networks.length} network(s)`);

  // 3. Networks, one session at a time.
  const voxels = padded.dims[0] * padded.dims[1] * padded.dims[2];
  const ensemble = new Float32Array(voxels);
  const span = 0.85 / networks.length;
  let available = backends.slice();
  for (let i = 0; i < networks.length; i++) {
    const asset = networks[i];
    const name = `network ${asset.fold + 1}`;
    const base = 0.08 + i * span;
    const modelData = await loadModel(asset, name, base, span * 0.3);
    let result = null;
    for (const backend of available) {
      postProgress(base + span * 0.3, `Loading ${name}...`);
      const t0 = performance.now();
      let session = null;
      try {
        session = await createSession(modelData, backend);
        const t1 = performance.now();
        const runNet = async (x) => {
          const input = new Tensor('float32', x, [1, 1, ...patch]);
          try {
            const output = (await session.run({ [plan.input]: input }))[plan.output];
            const data = output.location && output.location !== 'cpu' ? await output.getData() : output.data;
            output.dispose?.();
            return data;
          } finally {
            input.dispose?.();
          }
        };
        const onTile = (tile, total) => postProgress(base + span * (0.3 + 0.7 * tile / total), `Network ${asset.fold + 1}: patch ${tile}/${total}`);
        result = await nn.slidingWindowLogits(padded.data, padded.dims, patch, runNet,
          { mirrorAxes, gaussian, step: plan.tile_step_size, onTile });
        const t2 = performance.now();
        timing.folds.push({ fold: asset.fold, backend, sessionCreate: (t1 - t0) / 1000, inference: (t2 - t1) / 1000 });
        postLog(`Network ${asset.fold + 1} (${backend}): session ${((t1 - t0) / 1000).toFixed(1)} s, inference ${((t2 - t1) / 1000).toFixed(1)} s`);
        break;
      } catch (error) {
        if (backend === available.at(-1)) throw error;
        available = available.slice(available.indexOf(backend) + 1);
        postLog(`${backend} failed (${errorMessage(error)}); using ${available[0]}`);
      } finally {
        await session?.release();
      }
    }
    const p = nn.softmaxClass(result.logits, result.C, voxels, plan.marker_class);
    for (let v = 0; v < voxels; v++) ensemble[v] += p[v] / networks.length;
  }

  // 4. Back to the input grid: unpad, (resample back), uncrop (outside the crop: probability 0).
  let probability = nn.unpad(ensemble, padded.dims, workDims, padded.lo);
  if (resampled) probability = nn.resampleLinear(probability, workDims, cropped.dims);
  probability = nn.uncropBox(probability, dims, box);

  // 5. Candidates.
  postProgress(0.95, 'Selecting markers...');
  const detected = nn.detect(probability, dims, nMarkers, threshold, vx * vy * vz);
  const world = c => [0, 1, 2].map(r => affine[r][0] * c[0] + affine[r][1] * c[1] + affine[r][2] * c[2] + affine[r][3]);
  for (const marker of detected.markers.concat(detected.others)) marker.centroidWorldMm = world(marker.centroidVox);
  timing.total = (performance.now() - started) / 1000;

  postStageData('probability', createNiftiFromData(probability, headerBytes), `Marker probability (mean of ${networks.length} network(s))`);
  postStageData('markers', createNiftiFromData(detected.markerMap, headerBytes), `Top ${nMarkers} markers (value = rank)`);
  const { markerMap, ...summary } = detected;
  let markerVoxels = 0;
  for (let v = 0; v < markerMap.length; v++) if (markerMap[v] > 0) markerVoxels++;
  const detections = { ...summary, folds: networks.map(asset => asset.fold), mirror,
    backend: [...new Set(timing.folds.map(entry => entry.backend))].join('+'), timing };
  events.detections?.(detections);
  postLog(`Detected ${detected.markers.length}/${nMarkers} markers (${detected.nCandidates} candidates)`
    + (detected.countFlag ? ': fewer than the implant count, review the image' : ''));
  postLog(`Total time ${timing.total.toFixed(1)} s`);
  postProgress(1.0, 'Complete');
  return { model: 'v2', stages, detections, markerVoxels, dims: niftiDims,
    models: networks.map(({ id, sha256 }) => ({ id, sha256 })) };
}

/** Runs v2 (`model: 'v2'`, the default) or the legacy v1 consensus (`model: 'v1'`). */
export async function runInference(inputData, { model = 'v2', ...options }) {
  if (model === 'v1') return runLegacyInference(inputData, options);
  if (model === 'v2') return runNetworkInference(inputData, options);
  throw new Error(`Unknown SeedSeg model "${model}". Choose v2 or v1.`);
}
