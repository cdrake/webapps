// DOM-free steps of the sdc workflow: pairing the inputs, choosing b = 0 volumes, averaging
// them and naming the outputs.
import { isReversePair, phaseEncoding } from "@neurodesk/sdc";

/** Volumes with a b-value at or below this count as b = 0, as in the options document. */
export const B0_MAX = 50;

/**
 * The two series of a reverse phase-encoding pair. Image 1 is the field's reference: the DWI
 * series (the one with a bval) when exactly one has a bval, otherwise the first by name.
 * @param series [{ image: File, sidecar, bval: File|null }]
 */
export function selectPair(series) {
  const candidates = series.filter((entry) => entry.sidecar?.PhaseEncodingDirection);
  const missing = series.filter((entry) => !entry.sidecar?.PhaseEncodingDirection).map((entry) => entry.image.name);
  if (candidates.length !== 2) {
    const without = missing.length ? ` ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no sidecar with PhaseEncodingDirection.` : "";
    throw new Error(`Choose two images with opposite phase-encoding directions, each with its JSON sidecar; this selection has ${candidates.length}.${without}`);
  }
  const [a, b] = [...candidates].sort((x, y) => x.image.name.localeCompare(y.image.name));
  for (const entry of [a, b]) phaseEncoding(entry.sidecar.PhaseEncodingDirection);
  if (!isReversePair(a.sidecar.PhaseEncodingDirection, b.sidecar.PhaseEncodingDirection)) {
    throw new Error(`The images need opposite directions on one axis, not ${a.sidecar.PhaseEncodingDirection} and ${b.sidecar.PhaseEncodingDirection}.`);
  }
  return a.bval || !b.bval ? [a, b] : [b, a];
}

/** The indices of the b = 0 volumes: those with b ≤ B0_MAX, or every volume without a bval. */
export function b0Frames(bvalText, frames) {
  if (bvalText == null) return Array.from({ length: frames }, (_, k) => k);
  const values = bvalText.trim().split(/\s+/).filter(Boolean).map(Number);
  if (values.length !== frames || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`The bval has ${values.length} values for ${frames} volumes.`);
  }
  const keep = values.flatMap((v, k) => (v <= B0_MAX ? [k] : []));
  if (!keep.length) throw new Error(`The series has no volume with b ≤ ${B0_MAX}.`);
  return keep;
}

/** The voxel-wise mean of the chosen volumes, as Float64, summed in volume order. */
export function meanFrames(data, voxels, frames) {
  const out = new Float64Array(voxels);
  for (const frame of frames) {
    const offset = frame * voxels;
    for (let i = 0; i < voxels; i++) out[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) out[i] /= frames.length;
  return out;
}

/** The lengths of the affine's first three columns: the voxel size nibabel gives PyHySCO. */
export function voxelSizes(affine) {
  return [0, 1, 2].map((j) => Math.hypot(affine[0][j], affine[1][j], affine[2][j]));
}

/** True when two affines agree to `tolerance` mm in every entry. */
export function sameAffine(a, b, tolerance = 1e-3) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) if (Math.abs(a[r][c] - b[r][c]) > tolerance) return false;
  }
  return true;
}

/** BIDS stem of an image name, without its suffix and any desc entity. */
export function bidsStem(fileName) {
  const base = fileName.replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  const stem = match ? match[1] : base;
  return stem.split("_").filter((entity) => !entity.startsWith("desc-")).join("_");
}

/** Output names: the field map and the two quality-control images. */
export function outputNames(name1, name2) {
  const [stem1, stem2] = [bidsStem(name1), bidsStem(name2)];
  return {
    field: `${stem1}_fieldmap.nii.gz`,
    sidecar: `${stem1}_fieldmap.json`,
    corrected1: `${stem1}_desc-pyhyscoQC_b0.nii.gz`,
    corrected2: `${stem2 === stem1 ? `${stem2}_rev` : stem2}_desc-pyhyscoQC_b0.nii.gz`,
  };
}

/** The field map's sidecar. */
export function fieldSidecar({ image1, image2, phaseEncodingDirection, totalReadoutTime, iterations }) {
  return {
    Units: "Hz",
    Sources: [image1, image2],
    PhaseEncodingDirection: phaseEncodingDirection,
    TotalReadoutTime: totalReadoutTime,
    Description: `Susceptibility field from a reverse phase-encoding pair: PyHySCO 0.0.4 defaults (sdc app port), ${iterations} Gauss-Newton iterations. Sign as FSL topup: image 1 corrected is image1(x + field * TotalReadoutTime * PE sign) voxels.`,
  };
}
