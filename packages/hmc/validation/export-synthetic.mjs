// Writes the synthetic test series, its gradient files and this package's outputs for it into a
// directory, for validation/nifreeze_resampling.py.
//
//   node packages/hmc/validation/export-synthetic.mjs <out-dir>
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHmcNode, nodeRuntime } from "../src/node.js";
import { correctHeadMotion, readSeries } from "../src/pipeline.js";
import { ARGV, makeSeries, reference, sphereMask } from "../test/synthetic.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: node export-synthetic.mjs <out-dir>");
  process.exit(2);
}
await mkdir(out, { recursive: true });
const { nifti, bval, bvec, bvals, bvecs } = makeSeries();
const target = reference();
const { files } = await correctHeadMotion({
  series: await readSeries(nifti),
  bvals,
  bvecs,
  method: "nifreeze",
  target: (_, b0) => (b0 ? null : target),
  argv: () => [...ARGV],
  mask: sphereMask(),
  fileName: "sub-01_dwi.nii.gz",
  hmc: await loadHmcNode(),
  runtime: nodeRuntime({ workers: 4 }),
});
await writeFile(join(out, "sub-01_dwi.nii"), nifti);
await writeFile(join(out, "sub-01_dwi.bval"), bval);
await writeFile(join(out, "sub-01_dwi.bvec"), bvec);
for (const [name, bytes] of Object.entries(files)) await writeFile(join(out, name), bytes);
console.log(`wrote ${Object.keys(files).length + 3} files to ${out}`);
