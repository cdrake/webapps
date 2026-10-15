/**
 * Display-only NIfTI preview utilities.
 *
 * Builds a downsampled uint8 preview of a large NIfTI for WebGL viewers.
 * NIfTI parsing and writing live in NiftiUtils.js.
 */

function getGlobalNiftiDecoder() {
  const root = typeof window !== 'undefined' ? window : globalThis;
  return root.nifti || null;
}

function readNiftiHeaderView(buffer) {
  const view = new DataView(buffer);
  const littleEndian = view.getInt32(0, true) === 348;

  if (!littleEndian && view.getInt32(0, false) !== 348) {
    throw new Error('File is not a NIfTI-1 volume');
  }

  const dims = [];
  for (let i = 0; i < 8; i++) {
    dims.push(view.getInt16(40 + i * 2, littleEndian));
  }

  const datatype = view.getInt16(70, littleEndian);
  const bitpix = view.getInt16(72, littleEndian);
  const voxOffset = Math.max(352, Math.ceil(view.getFloat32(108, littleEndian) || 352));
  const sclSlope = view.getFloat32(112, littleEndian) || 1;
  const sclInter = view.getFloat32(116, littleEndian) || 0;

  if (dims[0] < 3 || dims[1] <= 0 || dims[2] <= 0 || dims[3] <= 0) {
    throw new Error('NIfTI volume has invalid dimensions');
  }

  return {
    view,
    littleEndian,
    dims,
    nx: dims[1],
    ny: dims[2],
    nz: dims[3],
    datatype,
    bitpix,
    voxOffset,
    sclSlope,
    sclInter
  };
}

function getDatatypeBytes(datatype) {
  switch (datatype) {
    case 2:
    case 256:
      return 1;
    case 4:
    case 512:
      return 2;
    case 8:
    case 16:
    case 768:
      return 4;
    case 64:
    case 1024:
    case 1280:
      return 8;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }
}

function readRawVoxel(view, byteOffset, datatype, littleEndian) {
  switch (datatype) {
    case 2:
      return view.getUint8(byteOffset);
    case 4:
      return view.getInt16(byteOffset, littleEndian);
    case 8:
      return view.getInt32(byteOffset, littleEndian);
    case 16:
      return view.getFloat32(byteOffset, littleEndian);
    case 64:
      return view.getFloat64(byteOffset, littleEndian);
    case 256:
      return view.getInt8(byteOffset);
    case 512:
      return view.getUint16(byteOffset, littleEndian);
    case 768:
      return view.getUint32(byteOffset, littleEndian);
    case 1024:
      return Number(view.getBigInt64(byteOffset, littleEndian));
    case 1280:
      return Number(view.getBigUint64(byteOffset, littleEndian));
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }
}

function readScaledVoxel(header, byteOffset) {
  return readRawVoxel(header.view, byteOffset, header.datatype, header.littleEndian) *
    header.sclSlope + header.sclInter;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return NaN;

  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function computePreviewDims(header, maxBytes, maxDimension) {
  const voxelCount = header.nx * header.ny * header.nz;
  const maxVoxels = Math.max(1, maxBytes);
  const voxelFactor = Math.ceil(Math.cbrt(voxelCount / maxVoxels));
  const dimensionFactor = Math.ceil(Math.max(header.nx, header.ny, header.nz) / maxDimension);
  const factor = Math.max(1, voxelFactor, dimensionFactor);

  return {
    nx: Math.max(1, Math.ceil(header.nx / factor)),
    ny: Math.max(1, Math.ceil(header.ny / factor)),
    nz: Math.max(1, Math.ceil(header.nz / factor)),
    factor
  };
}

function updatePreviewHeader(outputView, header, outputDims) {
  outputView.setInt16(40, 3, header.littleEndian);
  outputView.setInt16(42, outputDims.nx, header.littleEndian);
  outputView.setInt16(44, outputDims.ny, header.littleEndian);
  outputView.setInt16(46, outputDims.nz, header.littleEndian);
  outputView.setInt16(48, 1, header.littleEndian);
  outputView.setInt16(50, 1, header.littleEndian);
  outputView.setInt16(52, 1, header.littleEndian);
  outputView.setInt16(54, 1, header.littleEndian);

  outputView.setInt16(70, 2, header.littleEndian); // UINT8
  outputView.setInt16(72, 8, header.littleEndian);
  outputView.setFloat32(112, 1, header.littleEndian);
  outputView.setFloat32(116, 0, header.littleEndian);
  outputView.setFloat32(124, 255, header.littleEndian);
  outputView.setFloat32(128, 0, header.littleEndian);

  const scales = [
    header.nx / outputDims.nx,
    header.ny / outputDims.ny,
    header.nz / outputDims.nz
  ];

  for (let i = 0; i < 3; i++) {
    const pixdimOffset = 80 + i * 4;
    const pixdim = outputView.getFloat32(pixdimOffset, header.littleEndian);
    outputView.setFloat32(pixdimOffset, pixdim * scales[i], header.littleEndian);
  }

  const sformCode = outputView.getInt16(254, header.littleEndian);
  if (sformCode > 0) {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const offset = 280 + row * 16 + col * 4;
        outputView.setFloat32(
          offset,
          outputView.getFloat32(offset, header.littleEndian) * scales[col],
          header.littleEndian
        );
      }
    }
  }

  return scales;
}

/**
 * Create a display-only uint8 NIfTI preview from a larger source NIfTI.
 * Voxel intensities are robust-scaled into 0..255, and very large volumes are
 * spatially downsampled so WebGL viewers can use a much smaller texture.
 */
export async function createUint8PreviewNiftiFile(file, options = {}) {
  const {
    lowerPercentile = 0.005,
    upperPercentile = 0.995,
    maxSamples = 262144,
    maxPreviewBytes = 64 * 1024 ** 2,
    maxPreviewDimension = 512,
    suffix = '8bit-preview'
  } = options;

  let buffer = await file.arrayBuffer();
  const nifti = getGlobalNiftiDecoder();
  if (nifti?.isCompressed?.(buffer)) {
    buffer = nifti.decompress(buffer);
  }

  const header = readNiftiHeaderView(buffer);
  const bytesPerVoxel = getDatatypeBytes(header.datatype);
  const voxelCount = header.nx * header.ny * header.nz;
  const dataBytes = voxelCount * bytesPerVoxel;
  const outputDims = computePreviewDims(header, maxPreviewBytes, maxPreviewDimension);
  const outputVoxelCount = outputDims.nx * outputDims.ny * outputDims.nz;

  if (header.voxOffset + dataBytes > buffer.byteLength) {
    throw new Error('NIfTI image data is truncated');
  }

  const sampleStride = Math.max(1, Math.floor(voxelCount / maxSamples));
  const sampleCapacity = Math.ceil(voxelCount / sampleStride);
  const samples = new Float32Array(sampleCapacity);
  let sampleCount = 0;

  for (let i = 0; i < voxelCount; i += sampleStride) {
    const byteOffset = header.voxOffset + i * bytesPerVoxel;
    const value = readScaledVoxel(header, byteOffset);
    if (Number.isFinite(value)) {
      samples[sampleCount] = value;
      sampleCount += 1;
    }
  }

  if (sampleCount === 0) {
    throw new Error('No finite voxels found for display preview');
  }

  const sortedSamples = samples.subarray(0, sampleCount);
  sortedSamples.sort();

  let sourceMin = percentile(sortedSamples, lowerPercentile);
  let sourceMax = percentile(sortedSamples, upperPercentile);
  if (!Number.isFinite(sourceMin) || !Number.isFinite(sourceMax) || sourceMax <= sourceMin) {
    sourceMin = sortedSamples[0];
    sourceMax = sortedSamples[sortedSamples.length - 1];
  }
  if (sourceMax <= sourceMin) sourceMax = sourceMin + 1;

  const outputBuffer = new ArrayBuffer(header.voxOffset + outputVoxelCount);
  const inputBytes = new Uint8Array(buffer);
  const outputBytes = new Uint8Array(outputBuffer);
  const outputView = new DataView(outputBuffer);
  outputBytes.set(inputBytes.subarray(0, header.voxOffset));
  const scales = updatePreviewHeader(outputView, header, outputDims);
  const outputData = new Uint8Array(outputBuffer, header.voxOffset, outputVoxelCount);
  const scale = 255 / (sourceMax - sourceMin);

  for (let z = 0; z < outputDims.nz; z++) {
    const srcZ = Math.min(header.nz - 1, Math.floor((z + 0.5) * scales[2]));
    for (let y = 0; y < outputDims.ny; y++) {
      const srcY = Math.min(header.ny - 1, Math.floor((y + 0.5) * scales[1]));
      for (let x = 0; x < outputDims.nx; x++) {
        const srcX = Math.min(header.nx - 1, Math.floor((x + 0.5) * scales[0]));
        const inputIndex = srcX + srcY * header.nx + srcZ * header.nx * header.ny;
        const byteOffset = header.voxOffset + inputIndex * bytesPerVoxel;
        const value = readScaledVoxel(header, byteOffset);
        const scaled = Number.isFinite(value) ? Math.round((value - sourceMin) * scale) : 0;
        outputData[x + y * outputDims.nx + z * outputDims.nx * outputDims.ny] =
          Math.max(0, Math.min(255, scaled));
      }
    }
  }

  const baseName = (file.name || 'volume').replace(/\.(nii|nii\.gz)$/i, '');
  const previewFile = new File(
    [outputBuffer],
    `${baseName}.${suffix}.nii`,
    { type: 'application/octet-stream' }
  );

  return {
    file: previewFile,
    sourceMin,
    sourceMax,
    dims: [outputDims.nx, outputDims.ny, outputDims.nz],
    originalDims: [header.nx, header.ny, header.nz],
    downsampleFactors: scales,
    voxelCount,
    previewVoxelCount: outputVoxelCount,
    originalBytes: file.size || buffer.byteLength,
    previewBytes: previewFile.size
  };
}
