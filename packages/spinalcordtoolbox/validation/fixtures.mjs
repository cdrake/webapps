// The SCT reference cases the release check runs, pinned to commits with SHA-256.
// They are the web app's batch-parity fixtures (apps/spinalcordtoolbox/scripts/
// batch-parity-fixtures.cjs) at the revisions its downloader resolved.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HF = 'https://huggingface.co/datasets/sbollmann/sct-webapp-data/resolve/9ed55d734edbd3b4dcd2da298ab49ce277c1bc4e';
const SCT_TESTING_DATA = 'https://raw.githubusercontent.com/spinalcordtoolbox/sct_testing_data/af4c7e8783c9dcf8bcfc6c53b190af46260bb875';
// SCT-Course-20251208. The course image has no licence that allows re-hosting, so it is fetched upstream.
const SCT_TUTORIAL_DATA = 'https://raw.githubusercontent.com/spinalcordtoolbox/sct_tutorial_data/f176fd21cfb0e07978761bfff4867c5f848d4c01';

export const CASES = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    task: 'spinalcord',
    input: { url: `${HF}/test_data/batch_t2_deepseg_spinalcord/input.nii.gz`, sha256: '97638eee6df7c75b4de8921163e708420587de28b03eefb3fb1efbcdad659506' },
    references: {
      segmentation: { url: `${HF}/test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz`, sha256: '9bde73cd25d7f03a8ecebb09f14414f7213d3d016438b6efb948daebdf26bdb0' },
    },
    gates: { segmentation: 'batch_t2_deepseg_spinalcord' },
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2',
    task: 'lesion_sci_t2',
    input: { url: `${SCT_TESTING_DATA}/t2/t2_fake_lesion.nii.gz`, sha256: '2aeb4094afa9759ba31696fd8bbe27260d3d204eebcb1856334af8ed79733271' },
    references: {
      segmentation: { url: `${SCT_TESTING_DATA}/t2/t2_fake_lesion_sc_seg.nii.gz`, sha256: '3138cb11853b0a2fde0f3fbfa5ab73d6aaaaf29bff34992ad550534a3f60fd1c' },
      lesion: { url: `${SCT_TESTING_DATA}/t2/t2_fake_lesion_lesion_seg.nii.gz`, sha256: '1285077214a224a8fff1505e9ff91cebbf280e470229c00e6152ec37106ba421' },
    },
    gates: { segmentation: 'batch_t2_deepseg_lesion_sci_t2_sc', lesion: 'batch_t2_deepseg_lesion_sci_t2_lesion' },
  },
  {
    id: 'course_t2_ms_deepseg_lesion_ms',
    task: 'lesion_ms',
    input: { url: `${SCT_TUTORIAL_DATA}/single_subject/data/t2_ms/t2.nii.gz`, sha256: '5b25b71646e363cf0c24415db0eb0d836f0deb4ae0b024d1b939d505ab63783b' },
    references: {
      lesion: { url: `${HF}/test_data/course_t2_ms_deepseg_lesion_ms/batch_output_lesion.nii.gz`, sha256: 'bb8682532aa076b652e0f8d8ab764198fab2fe5036f3658842057abd69471f6c' },
    },
    gates: { lesion: 'course_t2_ms_deepseg_lesion_ms_lesion' },
  },
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A pinned file, downloaded once into a checksum-keyed cache under the temporary directory. */
export async function pinnedFile({ url, sha256: expected }) {
  const directory = join(tmpdir(), 'sct-webapp-validation', expected);
  const path = join(directory, url.split('/').pop());
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url} failed SHA-256 verification`);
  await mkdir(directory, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path).catch(async (error) => {
    await rm(partial, { force: true });
    throw error;
  });
  return path;
}
