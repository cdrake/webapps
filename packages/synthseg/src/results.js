// Output naming, CT detection and the label artifact, shared by the web app and the synthseg command line
// so both write the same downloads from the same decisions.
export const outputStem = (name) => name.replace(/\.nii(\.gz)?$/i, '');

/** The downloads for one input: the label map, its run report, the mri_synthseg volume table and the tissue maps. */
export function outputNames(inputName) {
  const stem = outputStem(inputName);
  return {
    labels: `${stem}_synthseg.nii.gz`,
    report: `${stem}_synthseg.json`,
    volumes: `${stem}_synthseg_vol.csv`,
    ...Object.fromEntries(TISSUES.map((tissue) => [tissue, `${stem}_synthseg_${tissue}.nii.gz`])),
  };
}

// The tissue probability maps, as exes/synthseg/src/post.rs groups the posteriors: each map is the sum of
// its structures' normalized posteriors, so GM + WM + CSF = 1 - P(background). Brainstem counts as WM and
// ventral DC as GM (FreeSurfer's SubCortGrayVol counts ventral DC).
export const TISSUES = Object.freeze(['gm', 'wm', 'csf']);
export const TISSUE_GROUPS = Object.freeze({
  gm: Object.freeze([3, 42, 8, 47, 10, 49, 11, 50, 12, 51, 13, 52, 17, 53, 18, 54, 26, 58, 28, 60]),
  wm: Object.freeze([2, 41, 7, 46, 16]),
  csf: Object.freeze([4, 43, 5, 44, 14, 15, 24]),
});
// FreeSurfer label of each VOLUME_COLUMNS entry after total intracranial (post.rs LABELS[1..]).
const VOLUME_LABELS = Object.freeze([
  2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 41, 42, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60,
]);

/** Each tissue's soft volume in mm³: the sum of its structures' volumes, which its map sums to times the voxel volume. */
export function tissueVolumes(volumes) {
  return Object.fromEntries(TISSUES.map((tissue) => [tissue, VOLUME_LABELS.reduce(
    (sum, label, index) => sum + (TISSUE_GROUPS[tissue].includes(label) ? volumes[VOLUME_COLUMNS[index + 1]] : 0),
    0,
  )]));
}

export const TISSUE_NAMES = Object.freeze({ gm: 'GM probability', wm: 'WM probability', csf: 'CSF probability' });

// mri_synthseg --vol columns after `subject`, in the order the pipeline reports them.
export const VOLUME_COLUMNS = Object.freeze([
  'total intracranial',
  'left cerebral white matter',
  'left cerebral cortex',
  'left lateral ventricle',
  'left inferior lateral ventricle',
  'left cerebellum white matter',
  'left cerebellum cortex',
  'left thalamus',
  'left caudate',
  'left putamen',
  'left pallidum',
  '3rd ventricle',
  '4th ventricle',
  'brain-stem',
  'left hippocampus',
  'left amygdala',
  'csf',
  'left accumbens area',
  'left ventral DC',
  'right cerebral white matter',
  'right cerebral cortex',
  'right lateral ventricle',
  'right inferior lateral ventricle',
  'right cerebellum white matter',
  'right cerebellum cortex',
  'right thalamus',
  'right caudate',
  'right putamen',
  'right pallidum',
  'right hippocampus',
  'right amygdala',
  'right accumbens area',
  'right ventral DC',
]);

// Python prints a whole float as "12.0"; otherwise JavaScript's shortest round-trip form matches repr().
const pythonFloat = (value) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** The mri_synthseg --vol table: a header and one row for `subject`, volumes in mm³, CRLF as Python's csv writes. */
export function volumesCsv(subject, volumes) {
  const header = ['subject', ...VOLUME_COLUMNS].join(',');
  const row = [subject, ...VOLUME_COLUMNS.map((name) => pythonFloat(volumes[name]))].join(',');
  return `${header}\r\n${row}\r\n`;
}

/** Parse an mri_synthseg --vol table with one subject row into `{ subject, volumes }`. */
export function parseVolumesCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split(','));
  if (rows.length !== 2 || rows[0].length !== rows[1].length || rows[0][0] !== 'subject') {
    throw new Error('Expected one header and one subject row in a SynthSeg volume table.');
  }
  const volumes = Object.fromEntries(rows[0].slice(1).map((name, index) => [name.trim(), Number(rows[1][index + 1])]));
  return { subject: rows[1][0], volumes };
}

// SynthSeg's CT path expects Hounsfield units; only CT scans store negatives.
export const looksLikeCt = (voxels) => voxels.some((value) => value < 0);

export const TISSUE_ARTIFACT = Object.freeze({
  type: 'neuro:volume',
  mediaType: 'application/gzip',
  space: 'subject-1mm',
});

export const LABELS_ARTIFACT = Object.freeze({
  type: 'neuro:label-map',
  mediaType: 'application/gzip',
  space: 'subject-1mm',
  labelSystem: 'FreeSurfer',
});
