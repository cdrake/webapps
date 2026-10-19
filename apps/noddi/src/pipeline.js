// DOM-free steps of the noddi workflow, shared by the page and its tests: the mean b0, voxel
// chunks for the workers, and BIDS derivative names for the maps (BEP016 dwimap).

/** The maps each model writes: BEP016 parameter label, worker output key, row label. */
export const MAPS = Object.freeze({
  tensor: [
    { param: "fa", key: "FA", label: "FA" },
    { param: "md", key: "MD", label: "MD" },
    { param: "ad", key: "AD", label: "AD" },
    { param: "rd", key: "RD", label: "RD" },
    { param: "s0", key: "S0", label: "S0" },
    { param: "direction", keys: ["V1x", "V1y", "V1z"], label: "Tensor direction" },
  ],
  noddi: [
    { param: "icvf", key: "ICVF", label: "ICVF" },
    { param: "isovf", key: "ISOVF", label: "ISOVF" },
    { param: "odi", key: "OD", label: "ODI" },
    { param: "direction", keys: ["dirx", "diry", "dirz"], label: "NODDI direction" },
  ],
});

/** The BIDS stem of a DWI file: its name without extension and without a trailing _dwi. */
export function bidsStem(fileName) {
  return fileName.replace(/\.nii(\.gz)?$/i, "").replace(/_dwi$/i, "");
}

/** BEP016 name of one parameter map: <stem>_model-<model>_param-<param>_dwimap.nii.gz. */
export function mapName(stem, model, param) {
  return `${stem}_model-${model}_param-${param}_dwimap.nii.gz`;
}

/** BIDS name of the brain mask used for the fit. */
export function maskName(stem) {
  return `${stem}_desc-brain_mask.nii.gz`;
}

/** Mean of the given volumes, voxel by voxel. `data` is volume-major. */
export function meanVolumes(data, voxels, volumes) {
  const mean = new Float32Array(voxels);
  for (const v of volumes) {
    const offset = v * voxels;
    for (let i = 0; i < voxels; i++) mean[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) mean[i] /= volumes.length;
  return mean;
}

/** Indices of the non-zero voxels of a mask. */
export function maskIndices(mask) {
  const indices = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) indices.push(i);
  return Uint32Array.from(indices);
}

/** Splits voxel indices into chunks of at most `size`. */
export function chunks(indices, size) {
  const out = [];
  for (let start = 0; start < indices.length; start += size) out.push(indices.subarray(start, start + size));
  return out;
}

/** The chunk's samples, volume-major over its voxels, as the WebAssembly fit takes them. */
export function gatherChunk(data, voxels, volumes, indices) {
  const out = new Float32Array(indices.length * volumes);
  for (let v = 0; v < volumes; v++) {
    const offset = v * voxels;
    const row = v * indices.length;
    for (let k = 0; k < indices.length; k++) out[row + k] = data[offset + indices[k]];
  }
  return out;
}

/** Full-size maps, zero outside the mask, for the outputs of one model. */
export function emptyMaps(model, voxels) {
  const maps = {};
  for (const map of MAPS[model]) {
    for (const key of map.keys ?? [map.key]) maps[key] = new Float32Array(voxels);
  }
  return maps;
}

/** Writes a chunk's outputs back to the voxel positions it came from. */
export function scatterChunk(maps, outputs, indices) {
  for (const [key, values] of Object.entries(outputs)) {
    const target = maps[key];
    if (!target) continue;
    for (let k = 0; k < indices.length; k++) target[indices[k]] = values[k];
  }
}

/** The values of the tensor-fit select control, as the automation schema and provenance name them. */
export const TENSOR_FITS = Object.freeze(["wls", "ols", "niimath-dtifit"]);

/** The niimath dtifit maps that the tensor maps come from (see dtifitMaps). */
export const DTIFIT_INPUTS = Object.freeze(["FA", "MD", "L1", "L2", "L3", "S0", "V1"]);

/** True when `volumes` is every volume of an `n`-volume series, in order. */
export function isEveryVolume(volumes, n) {
  return volumes.length === n && volumes.every((volume, i) => volume === i);
}

/** The given volumes of a volume-major series, in their order, as one volume-major array. */
export function selectVolumes(data, voxels, volumes) {
  const out = new Float32Array(voxels * volumes.length);
  volumes.forEach((volume, i) => out.set(data.subarray(volume * voxels, (volume + 1) * voxels), i * voxels));
  return out;
}

/** FSL bval and bvec text for the given volumes. */
export function gradientText(bvals, bvecs, volumes) {
  const bval = volumes.map((volume) => bvals[volume]).join(" ");
  const bvec = bvecs.map((row) => volumes.map((volume) => row[volume]).join(" ")).join("\n");
  return { bval: `${bval}\n`, bvec: `${bvec}\n` };
}

/**
 * The tensor maps from niimath dtifit's outputs, with the keys that the WebAssembly fit uses.
 * dtifit writes no AD or RD: AD is L1 and RD is the mean of L2 and L3. V1 is one 4D map of
 * three frames (x, y, z) and keeps the eigenvector sign that dtifit gives it. dtifit's V2, V3,
 * MO and tensor maps are not used.
 * @param {Record<string, Float32Array>} maps one array per name in DTIFIT_INPUTS
 */
export function dtifitMaps(maps, voxels) {
  for (const name of DTIFIT_INPUTS) {
    const expected = name === "V1" ? 3 * voxels : voxels;
    if (maps[name]?.length !== expected) throw new Error(`niimath dtifit wrote no ${name} map on the DWI grid.`);
  }
  const { FA, MD, L1, L2, L3, S0, V1 } = maps;
  const RD = new Float32Array(voxels);
  for (let i = 0; i < voxels; i++) RD[i] = (L2[i] + L3[i]) / 2;
  return {
    FA,
    MD,
    AD: L1,
    RD,
    S0,
    V1x: V1.slice(0, voxels),
    V1y: V1.slice(voxels, 2 * voxels),
    V1z: V1.slice(2 * voxels, 3 * voxels),
  };
}

/** A direction map as three frames (x, y, z) after one another, as a 4D NIfTI holds them. */
export function stackFrames(maps, keys) {
  const voxels = maps[keys[0]].length;
  const out = new Float32Array(voxels * keys.length);
  keys.forEach((key, frame) => out.set(maps[key], frame * voxels));
  return out;
}
