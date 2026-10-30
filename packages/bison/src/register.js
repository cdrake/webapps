// antsRegistration and --apply argv for BISON, in place of the MINC tools run_native.sh calls
// (bestlinreg_s2 + nlfit_s, mincresample, itk_resample), and Greedy's linear transforms as ITK .mat
// files: Greedy replaces the linear bestlinreg_s2 runs (docs/preprocessing.md#greedy). The argv run in @neurodesk/hmc-registration:
// one 3D float kernel that needs exactly one `--float 1` and one `--random-seed`. Callers load a new
// instance for each group of runs, so each group's heap is freed when it ends.
//
// Transform direction: an antsRegistration or Greedy transform maps fixed points to moving points.
// The template is the fixed image of the T1 registrations and the T1 is the fixed image of the FLAIR
// registration, so the T1 affines map template to T1 and the FLAIR rigid maps T1 to FLAIR.
//
// Transform order: hmc's --apply applies the LAST listed transform first to an output point
// (ITK composite queue in command-line order). antsApplyTransforms is the other way round: its
// parser stores options with push_front, so there the FIRST listed transform acts first. The lists
// below are written for hmc. docs/preprocessing.md has the derivation and the check.

import { writeMatTransform } from '@neurodesk/hmc-registration';

export const DEFAULT_SEED = 1234;

const MATTES_BINS = 32;
const SAMPLING = 'Regular,0.25';

function seedArgument(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 2147483647) throw new Error('The registration seed must be an integer from 1 to 2147483647.');
  return String(seed);
}

function common(seed) {
  return [
    '--dimensionality', '3',
    '--float', '1',
    '--random-seed', seedArgument(seed),
    '--collapse-output-transforms', '1',
    '--interpolation', 'Linear',
    '--use-histogram-matching', '0',
    '--winsorize-image-intensities', '[0.005,0.995]',
  ];
}

// Metrics by name: GC is minctracc's xcorr (bestlinreg_s2), CC with radius 2 the same-modality SyN
// metric, Mattes the cross-modality one (docs/preprocessing.md#metric-choice).
export const METRICS = Object.freeze({
  GC: (fixed, moving) => `GC[${fixed},${moving},1,1,${SAMPLING}]`,
  CC: (fixed, moving) => `CC[${fixed},${moving},1,2]`,
  Mattes: (fixed, moving) => `Mattes[${fixed},${moving},1,${MATTES_BINS},${SAMPLING}]`,
});

function metricOf(name, fixed, moving) {
  const build = METRICS[name];
  if (!build) throw new Error(`Unknown registration metric ${name}.`);
  return build(fixed, moving);
}

function stage({ transform, metric, fixed, moving, convergence, shrink, smoothing }) {
  return [
    '--transform', transform,
    '--metric', metricOf(metric, fixed, moving),
    '--convergence', `[${convergence},1e-6,10]`,
    '--shrink-factors', shrink,
    '--smoothing-sigmas', `${smoothing}vox`,
  ];
}

/**
 * Normalised T1 to template, as bestlinreg_s2 + nlfit_s -level 2: an affine refinement started
 * from the first affine, then SyN whose finest level is shrink 2 on the 1 mm template (2 mm, as
 * nlfit_s level 2 stops at a 2 mm step). Global correlation for the affine, neighbourhood
 * cross-correlation (radius 2) for SyN: both images are T1, and docs/preprocessing.md shows that
 * Mattes leaves the warped template far from the native one.
 * Writes `<output>0GenericAffine.mat`, `<output>1Warp.nii.gz` and `<output>1InverseWarp.nii.gz`.
 */
export function nonlinearArguments({ fixed, moving, initial, output, seed = DEFAULT_SEED, affineMetric = 'GC', synMetric = 'CC' }) {
  return [
    ...common(seed),
    '--initial-moving-transform', initial,
    ...stage({ transform: 'Affine[0.1]', metric: affineMetric, fixed, moving, convergence: '500x250x50', shrink: '4x2x1', smoothing: '2x1x0' }),
    ...stage({ transform: 'SyN[0.1,3,0]', metric: synMetric, fixed, moving, convergence: '100x70x50', shrink: '8x4x2', smoothing: '3x2x1' }),
    '--output', `[${output}]`,
  ];
}

const LPS = [-1, -1, 1];

/**
 * Greedy's matrix text (RAS, fixed point to moving point) as an ITK .mat: the same map in LPS, with
 * the fixed image as fixed, as antsRegistration writes `<prefix>0GenericAffine.mat`. The centre is
 * the origin, so the offset is the translation.
 */
export function greedyMatrixToMat(text) {
  const rows = text.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  if (rows.length !== 4 || rows.some((row) => row.length !== 4 || !row.every(Number.isFinite))) throw new Error('A Greedy matrix has four rows of four numbers.');
  const flip = (r, c) => LPS[r] * rows[r][c] * (c < 3 ? LPS[c] : 1);
  const matrix = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => flip(r, c)));
  const translation = [0, 1, 2].map((r) => flip(r, 3));
  return writeMatTransform({ transform: 'AffineTransform_double_3_3', parameters: [...matrix, ...translation], fixed: [0, 0, 0] });
}

const INTERPOLATIONS = ['Linear', 'NearestNeighbor', 'BSpline[2]'];

/** hmc --apply: resample `moving` onto the grid of `fixed`; the last transform acts first. */
export function applyArguments({ fixed, moving, output, interpolation, transforms, fill = 0 }) {
  if (!INTERPOLATIONS.includes(interpolation)) throw new Error(`Unsupported interpolation ${interpolation}.`);
  if (!Array.isArray(transforms) || transforms.length === 0) throw new Error('--apply needs at least one transform.');
  return ['--apply', fixed, moving, output, interpolation, String(fill), ...transforms];
}

/** Output point to template point, for template images on the T1 grid through the affine only. */
export function templateToT1Linear({ affine }) {
  return [`inverse:${affine}`];
}

/** T1 point to template point through the full transform: inverse affine first, then the inverse warp. */
export function templateToT1({ affine, inverseWarp }) {
  return [inverseWarp, `inverse:${affine}`];
}

/** FLAIR point to template point: inverse rigid (FLAIR to T1) first, then the inverse T1 affine. */
export function templateToFlair({ t1Affine, rigid }) {
  return [`inverse:${t1Affine}`, `inverse:${rigid}`];
}

/** T1 point to FLAIR point, to bring FLAIR onto the T1 grid. */
export function flairToT1({ rigid }) {
  return [rigid];
}

// ANTs picks the reader by file name, so a gzipped input keeps .nii.gz.
export function niftiName(base, bytes) {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? `${base}.nii.gz` : `${base}.nii`;
}

function outputsOf(result, names, argv) {
  for (const name of names) {
    if (!result.outputs[name]) throw new Error(`${argv[0] === '--apply' ? '--apply' : 'antsRegistration'} wrote no ${name}.`);
  }
  return result.outputs;
}

/** Runs argv on a registration instance (sync in Node, a worker promise in a browser). */
export async function runRegistration(registration, argv, inputs, expected, onLog) {
  const result = await registration.run(argv, inputs);
  if (onLog) for (const line of result.log ?? []) onLog(line);
  return outputsOf(result, expected, argv);
}

/** Resamples one image with --apply and returns the float32 NIfTI bytes. */
export async function applyTransforms(registration, { fixed, moving, interpolation, transforms, files, onLog }) {
  const fixedName = niftiName('fixed', fixed);
  const movingName = niftiName('moving', moving);
  const argv = applyArguments({ fixed: fixedName, moving: movingName, output: 'resampled.nii', interpolation, transforms });
  const inputs = { [fixedName]: fixed, [movingName]: moving, ...files };
  const outputs = await runRegistration(registration, argv, inputs, ['resampled.nii'], onLog);
  return outputs['resampled.nii'];
}
