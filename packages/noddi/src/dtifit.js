// The "niimath dtifit" tensor fit: DWI2TRX's shared fit (@neurodesk/dwi2trx), which runs the
// dtifit-enabled niimath build, on the volumes that the WebAssembly tensor fit uses.
// DOM-free, so the worker runs it in the browser and the tests run it in Node.
import { fitTensor } from "@neurodesk/dwi2trx";
import { createNiftiFromData, decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { DTIFIT_INPUTS, dtifitMaps, gradientText, isEveryVolume, selectVolumes } from "./pipeline.js";

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Fits the tensor with niimath --dtifit and returns the maps with the WebAssembly fit's keys
 * (FA, MD, AD, RD, S0, V1x, V1y, V1z).
 * @param run a niimath runner, as @neurodesk/dwi2trx's fitTensor takes
 * @param input.buffer the DWI as uncompressed NIfTI bytes
 * @param input.data its volume-major voxels; needed only when `volumes` is not every volume
 * @param input.volumes the tensor-fit volumes, from the gradient table's dtiVolumes
 * @param input.mask one value per voxel, non-zero inside the brain; null fits every voxel
 */
export async function fitDtifit(run, { buffer, data, dims, bvals, bvecs, volumes, mask }) {
  const voxels = dims[0] * dims[1] * dims[2];
  // With every volume the DWI goes to niimath unchanged, as DWI2TRX gives it.
  const dwi = isEveryVolume(volumes, bvals.length)
    ? new Uint8Array(buffer)
    : new Uint8Array(createNiftiFromData(selectVolumes(data, voxels, volumes), buffer, { dims: [...dims, volumes.length] }));
  const text = gradientText(bvals, bvecs, volumes);
  const encoder = new TextEncoder();
  const fitted = await fitTensor(run, {
    dwi: await gzip(dwi),
    bval: encoder.encode(text.bval),
    bvec: encoder.encode(text.bvec),
    mask: mask ? await gzip(new Uint8Array(createNiftiFromData(mask, buffer, { dims }))) : undefined,
    // V1 in the bvec frame, as the WebAssembly fit gives it, on every grid.
    xflip: "0",
  });
  const maps = {};
  for (const name of DTIFIT_INPUTS) maps[name] = readNiftiFrames(await decodeNiftiBuffer(fitted[name])).data;
  return dtifitMaps(maps, voxels);
}
