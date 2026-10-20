// A small synthetic two-shell DWI for browser tests: every voxel holds one stick-like tensor
// along x, so the fit has a known direction and low dispersion.
import { gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";

/** Three orthonormal axes, the first along `direction`. */
function frame(direction) {
  const norm = Math.hypot(...direction);
  const a = direction.map((value) => value / norm);
  const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const b0 = cross(a, t);
  const b = b0.map((value) => value / Math.hypot(...b0));
  return [a, b, cross(a, b)];
}

/**
 * Options: `direction` turns the first eigenvector from x to that direction (the second and third
 * are then two orthogonal axes); `affine` sets the sform rows; `bvecScale` multiplies each bvec
 * written to the bvec file, but not the gradients that make the signal.
 */
export function syntheticDwi({ size = 8, shells = [1000, 2000], directions = 30, eigenvalues = [1.7e-3, 0.3e-3, 0.3e-3], direction, affine, bvecScale = 1 } = {}) {
  const bvals = [0, 0];
  const bvecs = [[0, 0], [0, 0], [0, 0]];
  for (const b of shells) {
    for (let i = 0; i < directions; i++) {
      const z = 1 - (2 * (i + 0.5)) / directions;
      const r = Math.sqrt(1 - z * z);
      const phi = i * 2.399963229728653;
      bvals.push(b);
      bvecs[0].push(r * Math.cos(phi));
      bvecs[1].push(r * Math.sin(phi));
      bvecs[2].push(z);
    }
  }
  const voxels = size * size * size;
  const [l1, l2, l3] = eigenvalues;
  // Signal inside a one-voxel border of background, so the empty-mask test has background voxels.
  const inside = [];
  for (let z = 1; z < size - 1; z++) {
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) inside.push(x + size * (y + size * z));
    }
  }
  const data = new Float32Array(voxels * bvals.length);
  const axes = direction ? frame(direction) : null;
  bvals.forEach((b, v) => {
    const g = [bvecs[0][v], bvecs[1][v], bvecs[2][v]];
    const [p1, p2, p3] = axes ? axes.map((axis) => axis[0] * g[0] + axis[1] * g[1] + axis[2] * g[2]) : g;
    const s = 1000 * Math.exp(-b * (l1 * p1 ** 2 + l2 * p2 ** 2 + l3 * p3 ** 2));
    for (const i of inside) data[v * voxels + i] = s;
  });
  const header = createNiftiHeaderFromVolume({
    hdr: { dims: [4, size, size, size, bvals.length, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine },
  });
  const nifti = createNiftiFromData(data, header, { dims: [size, size, size, bvals.length] });
  return {
    files: [
      { name: "sub-01_dwi.nii.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(nifti)) },
      { name: "sub-01_dwi.bval", mimeType: "text/plain", buffer: Buffer.from(bvals.join(" ")) },
      { name: "sub-01_dwi.bvec", mimeType: "text/plain", buffer: Buffer.from(bvecs.map((row) => row.map((value) => value * bvecScale).join(" ")).join("\n")) },
    ],
    voxels,
    tissue: inside.length,
  };
}

/** A mask on the syntheticDwi grid with every voxel set to `value`. */
export function syntheticMask({ size = 8, value = 0 } = {}) {
  const header = createNiftiHeaderFromVolume({
    hdr: { dims: [3, size, size, size, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1] },
  });
  const nifti = createNiftiFromData(new Uint8Array(size ** 3).fill(value), header, { dims: [size, size, size] });
  return { name: "mask.nii.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(nifti)) };
}
