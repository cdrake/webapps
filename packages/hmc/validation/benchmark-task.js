// Host-neutral workload and verification. Loading and output verification sit outside the
// timed correctNiFreeze call; both hosts run exactly this code and the same pinned bytes.
import { decodeNiftiBuffer, readNiftiFrames, sameNiftiGrid } from "@neurodesk/webapp-components/file-io/nifti";
import { correctNiFreeze } from "../src/nifreeze.js";
import { readSeries } from "../src/pipeline.js";

const decoder = new TextDecoder();
const numbers = bytes => decoder.decode(bytes).trim().split(/\s+/).map(Number);
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");

export async function prepareBenchmark(config, { readBytes, loadHmc, runtime }) {
  const loadStart = performance.now();
  const series = await readSeries(await readBytes(config.files.image));
  const maskBytes = await decodeNiftiBuffer(await readBytes(config.files.mask));
  const mask = readNiftiFrames(maskBytes);
  if (mask.frames !== 1 || !sameNiftiGrid(series.headerBytes, maskBytes)) throw new Error("Benchmark mask is not one volume on the diffusion grid.");
  const bvals = numbers(await readBytes(config.files.bval));
  const bvecs = decoder.decode(await readBytes(config.files.bvec)).trim().split("\n").map(row => row.trim().split(/\s+/).map(Number));
  const hmc = await loadHmc();
  const input = { series, bvals, bvecs, mask: Uint8Array.from(mask.data, value => value ? 1 : 0), hmc, runtime, fileName: config.fileName, model: config.model, seed: config.seed };
  const b0 = hmc.b0Flags("nifreeze", bvals, bvecs);
  const expected = bvals.filter(value => value > 50).length;
  if (b0.some((flag, i) => flag !== (bvals[i] <= 50))) throw new Error("The benchmark b0 split does not match the NiFreeze threshold.");
  const loaded = { loadSeconds: (performance.now() - loadStart) / 1000, frames: series.frames, voxels: series.dims.reduce((a, b) => a * b), rawFloat32Bytes: series.data.byteLength, expectedRegistrations: expected };
  let result;
  let measured;
  return {
    loaded,
    async run() {
      const completed = { register: 0, resample: 0, write: 0 };
      const start = performance.now();
      result = await correctNiFreeze({ ...input, onProgress: event => { completed[event.stage] = event.done; } });
      measured = { seconds: (performance.now() - start) / 1000, completed };
      if (completed.register !== expected || completed.resample !== expected || completed.write !== 1) throw new Error("The benchmark did not complete every registration, resampling and output write.");
      return measured;
    },
    async verify() {
      if (!result) throw new Error("The measured operation has not completed.");
      const uncompressed = await decodeNiftiBuffer(result.files[result.names.image]);
      const written = readNiftiFrames(uncompressed);
      if (written.frames !== series.frames || written.data.length !== series.data.length) throw new Error("Benchmark output lost volumes.");
      for (let offset = 0; offset < written.data.length; offset++) {
        if (!Number.isFinite(written.data[offset])) throw new Error(`Benchmark output contains a nonfinite value at voxel ${offset}.`);
      }
      for (let frame = 0; frame < series.frames; frame++) if (b0[frame]) {
        for (let v = 0; v < loaded.voxels; v++) {
          const offset = frame * loaded.voxels + v;
          if (written.data[offset] !== series.data[offset]) throw new Error(`Benchmark changed b0 frame ${frame}.`);
        }
      }
      const bvecRows = decoder.decode(result.files[result.names.bvec]).trim().split("\n");
      if (numbers(result.files[result.names.bval]).length !== series.frames
        || bvecRows.length !== 3 || bvecRows.some(row => row.trim().split(/\s+/).length !== series.frames)
        || decoder.decode(result.files[result.names.motion]).trim().split("\n").length !== series.frames + 1
        || result.transforms.length !== series.frames) throw new Error("Benchmark output tables do not cover all frames.");
      const hashes = { [result.names.image]: await hash(uncompressed) };
      for (const [name, bytes] of Object.entries(result.files)) if (name !== result.names.image) hashes[name] = await hash(bytes);
      return { ...loaded, ...measured, hashes, verified: true };
    },
  };
}
