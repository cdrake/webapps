export function summarizeLabels({ data, header, dims }, lookup) {
  const counts = new Map();
  for (const value of data) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Segmentation contains an invalid label');
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const affine = header.affine.map(row => Array.from(row));
  const [a, b, c] = affine;
  const determinant = Math.abs(
    a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]),
  );
  const units = header.xyztUnits & 7;
  const millimeters = { 1: 1000, 2: 1, 3: 0.001 }[units];
  const voxelVolumeMl = millimeters && Number.isFinite(determinant) && determinant > 0
    ? determinant * millimeters ** 3 / 1000
    : null;
  const names = new Map(lookup.I.map((id, index) => [id, lookup.labels[index]]));
  return {
    geometry: { dimensions: dims, affine, spatialUnits: { 1: 'm', 2: 'mm', 3: 'um' }[units] || 'unknown' },
    voxelVolumeMl,
    ...(voxelVolumeMl === null && { volumeUnavailable: 'The output has unknown spatial units or an invalid affine.' }),
    labels: [...counts].sort(([left], [right]) => left - right).map(([id, voxels]) => ({
      id,
      name: names.get(id) || `Label ${id}`,
      voxels,
      ...(voxelVolumeMl === null ? {} : { volumeMl: voxels * voxelVolumeMl }),
    })),
  };
}
