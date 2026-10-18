// dcm2niix supplies images and acquisition metadata. This module supplies the
// study-specific BIDS decisions; it never guesses gradients or merges images.
import { gzipSync, strToU8, zip } from 'fflate';
import {
  clearNiftiText,
  decodeNiftiBuffer,
  parseNiftiHeader,
} from '@neurodesk/webapp-components/file-io/nifti';

export const BIDS_VERSION = '1.11.2';
export const SCAN_TYPES = ['exclude', 'T1w', 'T2w', 'FLAIR', 'dwi', 'epi'];
export const DIRECTIONS = ['i', 'i-', 'j', 'j-', 'k', 'k-'];
const LABEL = /^[a-zA-Z0-9]+$/;
const stem = (name) => name.replace(/\.(nii\.gz|nii|json|bval|bvec)$/i, '');
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Pair by exact output stem, including echo/split suffixes emitted by dcm2niix. */
export async function seriesFromOutputs(files, { signal } = {}) {
  const byName = new Map();
  for (const file of files) {
    if (byName.has(file.name)) throw new Error('Conversion produced duplicate output names.');
    byName.set(file.name, file);
  }
  const series = [];
  for (const image of files.filter((file) => /\.nii(\.gz)?$/i.test(file.name))) {
    signal?.throwIfAborted();
    const base = stem(image.name);
    const json = byName.get(`${base}.json`);
    const metadata = json ? JSON.parse(await json.text()) : {};
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
      throw new Error('Conversion produced an invalid JSON sidecar.');
    }
    const header = parseNiftiHeader(await decodeNiftiBuffer(await image.arrayBuffer(), { maxBytes: 352 }));
    if (header.dims[0] < 3 || header.dims[0] > 4 || header.dims.slice(1, header.dims[0] + 1).some((n) => n < 1)) {
      throw new Error('Only 3D and 4D MRI acquisitions are supported.');
    }
    const bval = byName.get(`${base}.bval`);
    const bvec = byName.get(`${base}.bvec`);
    const item = {
      id: `series${series.length + 1}`,
      image,
      metadata,
      description: metadata.SeriesDescription || metadata.ProtocolName || base,
      volumes: header.dims[0] === 4 ? header.dims[4] : 1,
      bval: bval ? await bval.text() : '',
      bvec: bvec ? await bvec.text() : '',
      acquisition: '',
      direction: DIRECTIONS.includes(metadata.PhaseEncodingDirection)
        ? metadata.PhaseEncodingDirection.replace('-', 'minus') : '',
      targets: [],
      reviewed: false,
    };
    item.type = suggestType(item);
    series.push(item);
  }
  signal?.throwIfAborted();
  if (!series.length) throw new Error('No images produced. Choose a complete MRI DICOM series.');
  // Identifiers remain in memory for review, even when the user later omits them.
  for (const key of ['StudyInstanceUID', 'PatientID']) {
    const values = new Set(series.map((item) => item.metadata[key]).filter(Boolean));
    if (values.size > 1) throw new Error('Choose one patient and one examination per import.');
  }
  return series;
}

export function suggestType(item) {
  const text = `${item.metadata.SeriesDescription || ''} ${item.metadata.ProtocolName || ''}`.toLowerCase();
  const imageType = [].concat(item.metadata.ImageType || []).join(' ').toUpperCase();
  if (/DERIVED|ADC|TRACE|FA\b/.test(imageType) || /locali[sz]er|scout|\badc\b|\btrace\b/.test(text)) return 'exclude';
  if (item.bval.trim()) {
    const b = item.bval.trim().split(/\s+/).map(Number);
    // A complete reversed diffusion acquisition retains its gradients in dwi/.
    if (b.some((value) => value > 50)) return 'dwi';
    if (/reverse|rev\b|topup|\bb0\b|bzero|se[_ -]?epi/.test(text)) return 'epi';
    return 'dwi';
  }
  if (/reverse|topup|se[_ -]?epi|\bb0\b|bzero/.test(text)) return 'epi';
  if (/flair/.test(text)) return 'FLAIR';
  if (/t1|mprage|spgr|bravo/.test(text)) return 'T1w';
  if (/t2|space|cube/.test(text)) return 'T2w';
  if (/dwi|dti|diffusion/.test(text)) return 'dwi';
  return 'exclude';
}

function gradientError(item) {
  if (!item.bval.trim() || !item.bvec.trim()) return 'Supply both bval and bvec files.';
  const b = item.bval.trim().split(/\s+/).map(Number);
  const rows = item.bvec.trim().split(/\r?\n/).map((row) => row.trim().split(/\s+/).map(Number));
  if (b.length !== item.volumes || rows.length !== 3 || rows.some((row) => row.length !== item.volumes)) {
    return `Gradients must contain ${item.volumes} b-values and 3 × ${item.volumes} vector values.`;
  }
  if (b.some((value) => !Number.isFinite(value) || value < 0) || rows.flat().some((value) => !Number.isFinite(value))) {
    return 'Gradients must contain finite numbers and nonnegative b-values.';
  }
  for (let n = 0; n < b.length; n++) {
    const length = Math.hypot(...rows.map((row) => row[n]));
    if (b[n] > 50 && Math.abs(length - 1) > 0.1) return 'Nonzero diffusion directions must be unit vectors.';
  }
  return null;
}

/** Validate only included acquisitions. A single supported scan is a valid input. */
export function validateDataset(series, options) {
  const errors = [];
  const add = (id, field, message) => errors.push({ id, field, message });
  for (const field of ['subject', 'session']) {
    if (!LABEL.test(options[field] || '')) add(null, field, 'Use a nonempty label containing letters and digits only.');
  }
  if (!options.name?.trim()) add(null, 'name', 'Enter a dataset name.');
  if (!['omit', 'retain'].includes(options.privacy)) add(null, 'privacy', 'Choose whether to omit or retain identifying metadata.');
  const included = series.filter((item) => item.type !== 'exclude');
  if (!included.length) add(null, 'series', 'Include at least one supported acquisition.');
  const byId = new Map(included.map((item) => [item.id, item]));
  for (const item of included) {
    if (!SCAN_TYPES.includes(item.type)) add(item.id, 'type', 'Choose a supported scan type.');
    if (!item.reviewed) add(item.id, 'reviewed', 'Confirm the scan type and metadata.');
    if (item.acquisition && !LABEL.test(item.acquisition)) add(item.id, 'acquisition', 'Use letters and digits only.');
    if (item.direction && !LABEL.test(item.direction)) add(item.id, 'direction', 'Use letters and digits only.');
    const meta = item.metadata;
    if (meta.Modality && meta.Modality !== 'MR') add(item.id, 'type', 'Only MR acquisitions are supported.');
    if (meta.ComplexImageComponent && meta.ComplexImageComponent !== 'MAGNITUDE') {
      add(item.id, 'type', 'Only magnitude images are supported; exclude phase, real and imaginary components.');
    }
    for (const key of ['EchoTime', 'RepetitionTime', 'TotalReadoutTime', 'EffectiveEchoSpacing']) {
      if (meta[key] !== undefined && !positive(meta[key])) add(item.id, key, `${key} must be a positive number in seconds.`);
    }
    if (meta.PhaseEncodingDirection !== undefined && !DIRECTIONS.includes(meta.PhaseEncodingDirection)) {
      add(item.id, 'PhaseEncodingDirection', 'Choose i, i-, j, j-, k or k- in NIfTI voxel axes.');
    }
    if ((item.direction || item.type === 'epi') && !DIRECTIONS.includes(meta.PhaseEncodingDirection)) {
      add(item.id, 'PhaseEncodingDirection', 'Enter the phase encoding direction from the acquisition metadata.');
    }
    if (item.type === 'dwi' || item.bval.trim() || item.bvec.trim()) {
      const message = gradientError(item);
      if (message) add(item.id, 'gradients', message);
    }
    if (item.type === 'epi') {
      if (!item.direction) add(item.id, 'direction', 'Enter a direction label for the fieldmap filename.');
      if (!positive(meta.TotalReadoutTime)) add(item.id, 'TotalReadoutTime', 'Enter total readout time in seconds.');
      if (!item.targets.length) add(item.id, 'targets', 'Select the DWI acquisition(s) this fieldmap serves.');
      for (const id of item.targets) {
        const target = byId.get(id);
        if (!target || target.type !== 'dwi') {
          add(item.id, 'targets', 'Every fieldmap target must be an included DWI acquisition.');
          continue;
        }
        if (!DIRECTIONS.includes(target.metadata.PhaseEncodingDirection)) {
          add(target.id, 'PhaseEncodingDirection', 'Enter the DWI phase encoding direction for distortion correction.');
        }
        if (!positive(target.metadata.TotalReadoutTime)) {
          add(target.id, 'TotalReadoutTime', 'Enter the DWI total readout time in seconds.');
        }
        const direction = meta.PhaseEncodingDirection;
        const targetDirection = target.metadata.PhaseEncodingDirection;
        if (DIRECTIONS.includes(direction) && DIRECTIONS.includes(targetDirection)
          && (direction[0] !== targetDirection[0] || direction === targetDirection)) {
          add(item.id, 'targets', 'The reverse image and its DWI target must have opposing phase encoding directions.');
        }
      }
    }
  }
  return errors;
}

// An allowlist makes the omit mode independent of arbitrary scanner free text.
// Direct identifiers, dates, protocol descriptions, institutions, device serial
// numbers and unknown vendor fields are omitted. Retain mode keeps the sidecar.
const TECHNICAL_FIELDS = new Set([
  'Modality', 'MagneticFieldStrength', 'ImagingFrequency', 'Manufacturer',
  'ManufacturersModelName', 'MRAcquisitionType', 'ScanningSequence', 'SequenceVariant',
  'ScanOptions', 'ImageType', 'ComplexImageComponent', 'EchoTime', 'EchoNumber',
  'RepetitionTime', 'InversionTime', 'FlipAngle', 'SliceThickness', 'SpacingBetweenSlices',
  'SliceTiming', 'MultibandAccelerationFactor', 'ParallelReductionFactorInPlane',
  'PartialFourier', 'PhaseEncodingDirection', 'TotalReadoutTime', 'EffectiveEchoSpacing',
  'ReconMatrixPE', 'AcquisitionMatrixPE', 'AcquisitionDuration', 'DwellTime',
  'PixelBandwidth', 'PercentPhaseFOV', 'PercentSampling', 'NumberOfAverages',
  'ReceiveCoilActiveElements', 'ConversionSoftware', 'ConversionSoftwareVersion',
  'B0FieldIdentifier', 'B0FieldSource', 'IntendedFor',
]);

export function exportMetadata(metadata, privacy) {
  if (privacy === 'retain') return structuredClone(metadata);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => TECHNICAL_FIELDS.has(key)));
}

/** Allocate names before writing associations, so every link names an actual output. */
export function datasetPaths(series, { subject, session }) {
  const included = series.filter((item) => item.type !== 'exclude');
  const prefix = `sub-${subject}_ses-${session}`;
  const base = (item) => prefix
    + (item.acquisition ? `_acq-${item.acquisition}` : '')
    + (item.direction ? `_dir-${item.direction}` : '');
  const keys = included.map((item) => `${base(item)}_${item.type}`);
  const counts = new Map();
  return new Map(included.map((item, index) => {
    const key = keys[index];
    const run = (counts.get(key) || 0) + 1;
    counts.set(key, run);
    const repeated = keys.filter((candidate) => candidate === key).length > 1;
    const name = `${base(item)}${repeated ? `_run-${run}` : ''}_${item.type}`;
    const datatype = item.type === 'epi' ? 'fmap' : item.type === 'dwi' ? 'dwi' : 'anat';
    return [item.id, `sub-${subject}/ses-${session}/${datatype}/${name}`];
  }));
}

export async function buildDataset(series, options, { signal, onProgress = () => {} } = {}) {
  const errors = validateDataset(series, options);
  if (errors.length) throw Object.assign(new Error('Review the highlighted fields before exporting.'), { errors });
  const paths = datasetPaths(series, options);
  const entries = {};
  const json = (path, value) => { entries[path] = strToU8(`${JSON.stringify(value, null, 2)}\n`); };
  json('dataset_description.json', { Name: options.name.trim(), BIDSVersion: BIDS_VERSION, DatasetType: 'raw' });
  entries.README = strToU8('MRI DICOM conversion curated with Neurodesk dcm2niix.\n'
    + 'Series types, subject/session labels and fieldmap associations were confirmed by the user.\n'
    + `Identifying metadata: ${options.privacy === 'omit' ? 'omitted using the app technical-field allowlist' : 'retained at user request'}.\n`
    + 'Images have not been defaced. No preprocessing, distortion correction or acquisition merging was applied.\n');
  entries['participants.tsv'] = strToU8(`participant_id\nsub-${options.subject}\n`);
  const included = series.filter((item) => paths.has(item.id));
  const fields = new Map(included.filter((item) => item.type === 'epi').map((item, index) => [item.id, `pepolar${index + 1}`]));
  for (let index = 0; index < included.length; index++) {
    signal?.throwIfAborted();
    const item = included[index];
    const path = paths.get(item.id);
    const metadata = exportMetadata(item.metadata, options.privacy);
    // Never carry stale associations from a previous export or source dataset.
    for (const key of ['IntendedFor', 'B0FieldIdentifier', 'B0FieldSource']) delete metadata[key];
    if (item.type === 'epi') {
      metadata.B0FieldIdentifier = fields.get(item.id);
      metadata.IntendedFor = item.targets.map((id) => `bids::${paths.get(id)}.nii.gz`);
    }
    const sources = included.filter((field) => field.type === 'epi' && field.targets.includes(item.id)).map((field) => fields.get(field.id));
    if (sources.length) {
      metadata.B0FieldSource = sources;
      // The forward DWI b=0 volumes and the reverse image jointly estimate B0.
      metadata.B0FieldIdentifier = sources;
    }
    json(`${path}.json`, metadata);
    let bytes = new Uint8Array(await decodeNiftiBuffer(await item.image.arrayBuffer()));
    signal?.throwIfAborted();
    if (options.privacy === 'omit') bytes = clearNiftiText(bytes);
    // Gzip is deterministic and does not embed the original scanner filename.
    entries[`${path}.nii.gz`] = gzipSync(bytes, { level: 1, mtime: 0 });
    if (item.bval.trim()) entries[`${path}.bval`] = strToU8(item.bval.trim() + '\n');
    if (item.bvec.trim()) entries[`${path}.bvec`] = strToU8(item.bvec.trim() + '\n');
    onProgress((index + 1) / included.length);
    // Yield between acquisitions so the footer cancel button remains usable.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return { entries, paths, count: included.length };
}

/** Async ZIP uses fflate workers; cancelling terminates compression immediately. */
export function datasetZip(entries, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      terminate();
      reject(signal.reason);
    };
    const terminate = zip(entries, { level: 0 }, (error, bytes) => {
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(bytes);
    });
    signal?.addEventListener('abort', abort, { once: true });
  });
}
