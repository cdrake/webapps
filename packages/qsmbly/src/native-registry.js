// The hosted native cache filenames and checksums from qsm-core's pinned Rust registry.
export function nativeWeights(source) {
  const weights = [];
  for (const [, block] of source.matchAll(/WeightFile\s*\{([^}]+)\}/g)) {
    const filename = /name:\s*"([^"]+)"/.exec(block)?.[1];
    const url = /url:\s*"([^"]+)"/.exec(block)?.[1];
    if (!filename || !url) continue;
    const sha256 = /sha256:\s*"([^"]+)"/.exec(block)?.[1];
    const bytes = Number(/bytes:\s*([\d_]+)/.exec(block)?.[1]?.replaceAll('_', ''));
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? '') || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`Native weight ${filename} has no complete checksum and size.`);
    }
    weights.push({ filename, sha256, bytes });
  }
  if (!weights.length) throw new Error('The pinned native registry contains no hosted weights.');
  return weights;
}

export function verifyNativeWeights(source, assets, inventory) {
  const ordered = (files) => files.map(({ filename, sha256, bytes }) => ({ filename, sha256, bytes })).sort((a, b) => a.filename.localeCompare(b.filename));
  const weights = nativeWeights(source);
  if (JSON.stringify(ordered(weights)) !== JSON.stringify(ordered(assets)) ||
      JSON.stringify(weights.map((file) => file.filename).sort()) !== JSON.stringify([...inventory].sort())) {
    throw new Error('The model manifest must pin every hosted native QSMxT weight with its exact filename, SHA-256 and size.');
  }
}

export function verifyNativeExamples(source, assets) {
  const examples = [...source.matchAll(/Example\s*\{([^}]+)\}/g)].flatMap(([, block]) => {
    const id = /id:\s*"([^"]+)"/.exec(block)?.[1];
    if (!id) return [];
    return [{
      filename: `${id}.zip`,
      sha256: /sha256:\s*"([^"]+)"/.exec(block)?.[1],
      bytes: Number(/bytes:\s*([\d_]+)/.exec(block)?.[1]?.replaceAll('_', '')),
    }];
  });
  const ordered = (files) => files.map(({ filename, sha256, bytes }) => ({ filename, sha256, bytes })).sort((a, b) => a.filename.localeCompare(b.filename));
  if (!examples.length || JSON.stringify(ordered(examples)) !== JSON.stringify(ordered(assets))) {
    throw new Error('The example manifest must mirror every native QSMxT acquisition with its exact filename, SHA-256 and size.');
  }
}
