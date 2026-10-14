// A float32 NIfTI-1 volume with an sform, for tests that need a real input file.
export function niftiBytes(dims, values, { srow = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] } = {}) {
  const buffer = new ArrayBuffer(352 + values.length * 4);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  [3, ...dims, 1, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  [1, ...srow.map(row => Math.hypot(row[0], row[1], row[2]))].forEach((value, index) => view.setFloat32(76 + index * 4, value, true));
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  srow.forEach((row, rowIndex) => row.forEach((value, column) => view.setFloat32(280 + rowIndex * 16 + column * 4, value, true)));
  new Uint8Array(buffer, 344, 4).set([0x6e, 0x2b, 0x31, 0]);
  new Float32Array(buffer, 352).set(values);
  return buffer;
}

export function niftiVoxels(niftiData) {
  const view = new DataView(niftiData);
  const offset = Math.ceil(view.getFloat32(108, true));
  const dims = [42, 44, 46].map(position => view.getInt16(position, true));
  return { dims, datatype: view.getInt16(70, true), voxels: new Uint8Array(niftiData, offset) };
}
