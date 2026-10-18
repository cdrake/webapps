// A small 4D test series: in every axial slice, a square with sharp edges, so ringing removal
// changes the samples next to them; two identical volumes.
import { gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";

export function squareSeries({ nx = 32, ny = 24, nz = 3, frames = 2 } = {}) {
  const voxels = nx * ny * nz;
  const data = new Float32Array(voxels * frames);
  for (let f = 0; f < frames; f++) {
    for (let z = 0; z < nz; z++) {
      for (let y = 6; y < 18; y++) {
        for (let x = 10; x < 22; x++) data[f * voxels + x + nx * (y + ny * z)] = 100;
      }
    }
  }
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [4, nx, ny, nz, frames, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1] } });
  const nifti = createNiftiFromData(data, header, { dims: [nx, ny, nz, frames] });
  return {
    files: [
      { name: "sub-01_dwi.nii.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(nifti)) },
      { name: "sub-01_dwi.bval", mimeType: "text/plain", buffer: Buffer.from("0 1000") },
      { name: "sub-01_dwi.bvec", mimeType: "text/plain", buffer: Buffer.from("0 1\n0 0\n0 0") },
    ],
    data,
    voxels,
  };
}
