import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, strFromU8, unzipSync } from 'fflate';
import { buildDataset, datasetPaths, datasetZip, exportMetadata, seriesFromOutputs, validateDataset } from '../src/bids.js';

// A tiny independent NIfTI fixture makes voxel order and text removal observable.
function image(name = 'scan.nii', volumes = 1) {
  const bytes = new Uint8Array(352 + 8 * volumes);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [volumes > 1 ? 4 : 3, 2, 2, 2, volumes, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  view.setInt16(70, 2, true);
  view.setInt16(72, 8, true);
  view.setFloat32(108, 352, true);
  bytes.set(new TextEncoder().encode('PATIENT^IDENTIFIER'), 148);
  bytes.set(new TextEncoder().encode('n+1\0'), 344);
  for (let index = 352; index < bytes.length; index++) bytes[index] = index % 251;
  return new File([bytes], name);
}
async function acquisition(type, { metadata = {}, volumes = 1, name = 'scan', bval, bvec } = {}) {
  const files = [image(`${name}.nii`, volumes), new File([JSON.stringify({ Modality: 'MR', ...metadata })], `${name}.json`)];
  if (bval !== undefined) files.push(new File([bval], `${name}.bval`));
  if (bvec !== undefined) files.push(new File([bvec], `${name}.bvec`));
  const [item] = await seriesFromOutputs(files);
  return { ...item, type, reviewed: true };
}
const settings = { subject: '01', session: '01', name: 'Test MRI', privacy: 'omit' };
const json = (entries, name) => JSON.parse(strFromU8(entries[name]));

test('each anatomical contrast alone exports a complete dataset without requiring other scans', async () => {
  for (const type of ['T1w', 'T2w', 'FLAIR']) {
    const item = await acquisition(type);
    const { entries } = await buildDataset([item], settings);
    assert.equal(json(entries, 'dataset_description.json').BIDSVersion, '1.11.2');
    assert.ok(entries.README);
    assert.equal(strFromU8(entries['participants.tsv']), 'participant_id\nsub-01\n');
    assert.ok(entries[`sub-01/ses-01/anat/sub-01_ses-01_${type}.nii.gz`]);
    assert.deepEqual(validateDataset([item], settings), []);
  }
});

test('pairing follows output stems rather than output order, preserving DWI voxel/gradient order', async () => {
  const files = [image('diffusion.nii', 2), new File(['0 1000'], 'diffusion.bval'), new File(['0 1\n0 0\n0 0'], 'diffusion.bvec'), new File(['{}'], 'diffusion.json')];
  const [item] = await seriesFromOutputs(files.reverse());
  assert.equal(item.type, 'dwi');
  const { entries } = await buildDataset([{ ...item, reviewed: true }], settings);
  const base = 'sub-01/ses-01/dwi/sub-01_ses-01_dwi';
  assert.equal(strFromU8(entries[`${base}.bval`]), '0 1000\n');
  assert.equal(strFromU8(entries[`${base}.bvec`]), '0 1\n0 0\n0 0\n');
  const pixels = gunzipSync(entries[`${base}.nii.gz`]).subarray(352);
  assert.deepEqual(pixels, new Uint8Array(await item.image.arrayBuffer()).subarray(352));
});

test('unknown scans start excluded, full reversed DWI stays dwi and reverse b0 suggests fmap', async () => {
  const [unknown] = await seriesFromOutputs([image(), new File(['{}'], 'scan.json')]);
  assert.equal(unknown.type, 'exclude');
  for (const [bval, expected] of [['0 1000', 'dwi'], ['0 0', 'epi']]) {
    const item = await acquisition('dwi', { metadata: { SeriesDescription: 'dwi_reverse' }, volumes: 2, bval, bvec: '0 1\n0 0\n0 0' });
    const files = [item.image, new File([JSON.stringify(item.metadata)], 'scan.json'), new File([bval], 'scan.bval'), new File([item.bvec], 'scan.bvec')];
    assert.equal((await seriesFromOutputs(files))[0].type, expected);
  }
});

test('missing, mismatched and invalid gradients require correction', async () => {
  const item = await acquisition('dwi', { volumes: 2 });
  assert.ok(validateDataset([item], settings).some((error) => error.field === 'gradients'));
  item.bval = '0 1000';
  item.bvec = '0 1\n0 0\n0 0';
  assert.deepEqual(validateDataset([item], settings), []);
  for (const bvec of ['0 1\n0 0', '0 NaN\n0 0\n0 0', '0 0\n0 0\n0 0']) {
    assert.ok(validateDataset([{ ...item, bvec }], settings).some((error) => error.field === 'gradients'));
  }
});

test('reverse fieldmaps name actual DWI targets and identify both forward and reverse B0 sources', async () => {
  const dwi = { ...await acquisition('dwi', { volumes: 2, bval: '0 1000', bvec: '0 1\n0 0\n0 0', metadata: { PhaseEncodingDirection: 'j', TotalReadoutTime: 0.05 } }), id: 'dwi' };
  const reverse = { ...await acquisition('epi', { metadata: { PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.05 } }), id: 'reverse', targets: ['dwi'] };
  const { entries, paths } = await buildDataset([dwi, reverse], settings);
  assert.match(paths.get('reverse'), /\/fmap\/.*_dir-jminus_epi$/);
  const fmap = json(entries, `${paths.get('reverse')}.json`);
  const target = json(entries, `${paths.get('dwi')}.json`);
  assert.deepEqual(fmap.IntendedFor, [`bids::${paths.get('dwi')}.nii.gz`]);
  assert.deepEqual(target.B0FieldSource, [fmap.B0FieldIdentifier]);
  assert.deepEqual(target.B0FieldIdentifier, target.B0FieldSource);
  reverse.metadata.PhaseEncodingDirection = 'j';
  assert.ok(validateDataset([dwi, reverse], settings).some((error) => /opposing/.test(error.message)));
  delete reverse.metadata.TotalReadoutTime;
  assert.ok(validateDataset([dwi, reverse], settings).some((error) => error.field === 'TotalReadoutTime'));
  reverse.targets = ['unknown'];
  assert.ok(validateDataset([dwi, reverse], settings).some((error) => error.field === 'targets'));
});

test('separate repeated acquisitions receive unique run paths without merging', async () => {
  const one = await acquisition('T1w');
  const two = { ...one, id: 'series2' };
  const paths = datasetPaths([one, two], settings);
  assert.match(paths.get(one.id), /_run-1_T1w$/);
  assert.match(paths.get(two.id), /_run-2_T1w$/);
});

test('privacy is explicit and omit filters unknown text and NIfTI text without changing the source', async () => {
  const metadata = { PatientName: 'PRIVATE', PatientID: 'ID', AcquisitionDateTime: '2026-01-01', ProtocolName: 'PRIVATE', UnrecognizedPrivateField: 'PRIVATE', EchoTime: 0.003 };
  const item = await acquisition('T1w', { metadata });
  assert.ok(validateDataset([item], { ...settings, privacy: '' }).some((error) => error.field === 'privacy'));
  assert.equal(exportMetadata(metadata, 'omit').PatientName, undefined);
  assert.deepEqual(exportMetadata(metadata, 'retain'), metadata);
  for (const privacy of ['omit', 'retain']) {
    const { entries, paths } = await buildDataset([item], { ...settings, privacy });
    const base = paths.get(item.id);
    const output = json(entries, `${base}.json`);
    assert.equal(output.EchoTime, 0.003);
    assert.equal(output.PatientName, privacy === 'retain' ? 'PRIVATE' : undefined);
    assert.equal(gunzipSync(entries[`${base}.nii.gz`])[148] > 0, privacy === 'retain');
  }
  assert.notEqual(new Uint8Array(await item.image.arrayBuffer())[148], 0);
});

test('unreviewed scans and unsafe labels cannot produce an archive; excluded scans do not block', async () => {
  const item = await acquisition('T1w');
  await assert.rejects(buildDataset([{ ...item, reviewed: false }], settings), /highlighted/);
  assert.ok(validateDataset([item], { ...settings, subject: '../patient' }).length);
  assert.deepEqual(validateDataset([item, { ...item, id: 'excluded', type: 'exclude', reviewed: false }], settings), []);
  const dataset = await buildDataset([item], settings);
  const archive = unzipSync(await datasetZip(dataset.entries));
  assert.deepEqual(Object.keys(archive).sort(), Object.keys(dataset.entries).sort());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildDataset([item], settings, { signal: controller.signal }), { name: 'AbortError' });
});
