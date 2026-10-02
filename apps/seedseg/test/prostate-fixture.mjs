import { createNiftiFromVolume } from '../../../packages/components/src/file-io/NiftiUtils.js';

// Synthetic transport fixture, not a clinical accuracy reference or public app example.
export function createProstateFixture() {
  const dims = [64, 64, 32];
  const img = new Float32Array(dims.reduce((a, b) => a * b));
  const seeds = [[25, 27, 10], [39, 28, 16], [31, 40, 22]];
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        const tissue = ((x - 32) / 29) ** 2 + ((y - 32) / 28) ** 2 + ((z - 16) / 24) ** 2;
        const prostate = ((x - 32) / 22) ** 2 + ((y - 33) / 18) ** 2 + ((z - 16) / 15) ** 2;
        let value = tissue < 1 ? 80 : 0;
        if (prostate < 1) value = 115;
        else if (tissue < 0.95) value += 25 * Math.sin(x * 0.18) ** 2;
        value *= (0.8 + 0.4 * x / dims[0]) * (1 + 0.04 * Math.sin(x * 2.1 + y * 1.7 + z * 1.3));
        if (seeds.some(([sx, sy, sz]) => (x - sx) ** 2 + (y - sy) ** 2 <= 1 && Math.abs(z - sz) <= 2)) value = 3;
        img[x + dims[0] * (y + dims[1] * z)] = value;
      }
    }
  }
  return Buffer.from(createNiftiFromVolume({ img, hdr: { dims, pixDims: [1, 1, 1], affine: [[1, 0, 0, -32], [0, 1, 0, -32], [0, 0, 1, -16], [0, 0, 0, 1]] } }));
}
