export const VERSION = '0.6.20261024';

// Model weights and their pins live in packages/seedseg/model.manifest.json (= models/seedseg.manifest.json):
// v2, the nnU-Net ResEnc networks of the five cross-validation folds, at a pinned commit of the
// Hugging Face model repo ash347/seedseg; v1 (legacy), the four 3D U-Nets of the previous release.
export const FOLDS = ['0', '1', '2', '3', '4'];

export const INFERENCE_DEFAULTS = {
  threshold: 0.1,
  nMarkers: 3,
  folds: ['0'],
  mirror: false,
  backend: 'auto' // WebGPU when available, else WebAssembly
};

export const VIEWER_CONFIG = {
  loadingText: "",
  dragToMeasure: false,
  isColorbar: false,
  textHeight: 0.03,
  show3Dcrosshair: false,
  crosshairColor: [0.23, 0.51, 0.96, 1.0],
  crosshairWidth: 0.75
};

export const PROGRESS_CONFIG = {
  animationSpeed: 0.5,
  progressBarId: 'progress',
  statusTextId: 'statusText',
  elapsedId: 'elapsed',
  cancelId: 'cancelButton'
};


export const STAGE_NAMES = {
  'input': 'Input T1w',
  'probability': 'Probability',
  'markers': 'Markers'
};

export const CACHE_CONFIG = {
  name: 'SeedSegModelCache',
  storeName: 'models',
  maxSizeMB: 1100
};

if (typeof self !== 'undefined') self.SeedSegConfig = { VERSION, FOLDS, INFERENCE_DEFAULTS, VIEWER_CONFIG, PROGRESS_CONFIG, STAGE_NAMES, CACHE_CONFIG };
