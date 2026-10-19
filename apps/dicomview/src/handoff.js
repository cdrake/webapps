// Sending the selected image to White matter lesions, which segments one 3D FLAIR.
import { describeNiftiFile } from '@neurodesk/webapp-components/file-io/nifti';
import { downloadFiles } from './series-text.js';

export const LESIONS = Object.freeze({ path: 'white-matter-lesions', title: 'White matter lesions' });

// Why an image cannot be sent, or null when it can: a time series or a single slice cannot.
export async function lesionHandoffBlocker(image) {
  const { dimensionality, frames } = await describeNiftiFile(image);
  if (frames > 1) return `${LESIONS.title} takes one 3D image; this one has ${frames} volumes.`;
  if (dimensionality < 3) return `${LESIONS.title} takes a 3D image; this one is a single slice.`;
  return null;
}

// The image alone, named as its download is: series number and description, without the
// patient's name or the study date dcm2niix puts in its own names. White matter lesions reads
// no sidecar, so none is sent.
export function handoffImage(series, outputs, output, allSeries) {
  return downloadFiles(series, outputs, allSeries)[output].image;
}
