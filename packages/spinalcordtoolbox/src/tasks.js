/*
 * The web app's SCT task inventory (model.manifest.json, a byte-identical copy of
 * apps/spinalcordtoolbox/web/models/manifest.json) and the run settings the app
 * derives from it in runSegmentation().
 */
import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };
export const DEFAULT_TASK_ID = 'spinalcord';

// apps/spinalcordtoolbox/web/js/app/config.js INFERENCE_DEFAULTS, for settings a model leaves unset.
export const INFERENCE_DEFAULTS = Object.freeze({
  overlap: 0,
  probabilityThreshold: 0.5,
  minComponentSize: 10,
  keepLargestComponent: false,
  testTimeAugmentation: false,
});

// The automation contract's ranges for the user's settings.
export const THRESHOLD_RANGE = Object.freeze([0.01, 0.5]);

export function runnableTasks() {
  return manifest.tasks.filter(task => task.supportStatus === 'supported' && task.modelAssets?.length);
}

export function getTask(taskId) {
  const task = runnableTasks().find(candidate => candidate.id === taskId);
  if (!task) {
    throw new Error(`Unknown or unsupported task "${taskId}". Choose one of: ${runnableTasks().map(candidate => candidate.id).join(', ')}`);
  }
  return task;
}

/** The pinned model file of a task: URL, size and SHA-256. */
export function modelAsset(task) {
  const asset = task.modelAssets[0];
  const sha256 = asset.checksum?.replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(sha256 || '') || !Number.isSafeInteger(asset.sizeBytes)) {
    throw new Error(`${task.id}: model ${asset.filename} has no pinned SHA-256 and size`);
  }
  return Object.freeze({
    taskId: task.id,
    filename: asset.filename,
    url: asset.downloadUrl,
    bytes: asset.sizeBytes,
    sha256,
    sourceVersion: asset.sourceVersion,
  });
}

/**
 * The `run-inference` settings the web app sends its worker for this task, with
 * the user's optional threshold, minimum component size and test-time augmentation.
 */
export function runSettings(task, { threshold, minimumComponentSize, testTimeAugmentation = false } = {}) {
  const asset = task.modelAssets[0];
  const defaults = asset.inferenceDefaults || {};
  if (threshold !== undefined && !(threshold >= THRESHOLD_RANGE[0] && threshold <= THRESHOLD_RANGE[1])) {
    throw new Error(`threshold must be between ${THRESHOLD_RANGE[0]} and ${THRESHOLD_RANGE[1]}`);
  }
  if (minimumComponentSize !== undefined && !(Number.isSafeInteger(minimumComponentSize) && minimumComponentSize >= 0)) {
    throw new Error('minimum component size must be a non-negative integer');
  }
  return {
    taskId: task.id,
    supportStatus: task.supportStatus,
    overlap: defaults.overlap ?? INFERENCE_DEFAULTS.overlap,
    threshold: threshold ?? defaults.probabilityThreshold ?? INFERENCE_DEFAULTS.probabilityThreshold,
    minComponentSize: minimumComponentSize ?? defaults.minComponentSize ?? INFERENCE_DEFAULTS.minComponentSize,
    keepLargestComponent: !!(defaults.keepLargestComponent ?? INFERENCE_DEFAULTS.keepLargestComponent),
    testTimeAugmentation: !!testTimeAugmentation,
    patchSize: asset.patchSize || task.patchSize,
    preprocessing: asset.preprocessing || {},
    output: asset.output || {},
  };
}

/** The web app's download name for a NIfTI stage (SctPipeline resultFileName). */
export function resultFileName(taskId, stage) {
  return `${taskId}_${stage}.nii`;
}
