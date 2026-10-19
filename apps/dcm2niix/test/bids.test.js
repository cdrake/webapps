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

test('anatomical outputs never carry direction entities, including after a scan type edit', async () => {
  const [suggested] = await seriesFromOutputs([
    image(), new File([JSON.stringify({ SeriesDescription: 'MPRAGE', PhaseEncodingDirection: 'j-' })], 'scan.json'),
  ]);
  assert.equal(suggested.type, 'T1w');
  assert.equal(suggested.direction, '');
  const item = await acquisition('dwi', { metadata: { PhaseEncodingDirection: 'j-' }, bval: '0', bvec: '0\n0\n0' });
  assert.equal(item.direction, 'jminus');
  assert.match(datasetPaths([item], settings).get(item.id), /_dir-jminus_dwi$/);
  for (const type of ['T1w', 'T2w', 'FLAIR']) {
    item.type = type;
    item.bval = '';
    item.bvec = '';
    const { entries, paths } = await buildDataset([item], settings);
    const path = `sub-01/ses-01/anat/sub-01_ses-01_${type}`;
    assert.equal(paths.get(item.id), path);
    assert.ok(entries[`${path}.nii.gz`]);
    assert.equal(json(entries, `${path}.json`).PhaseEncodingDirection, 'j-');
  }
  const second = { ...item, id: 'series2', direction: 'other' };
  assert.deepEqual([...datasetPaths([item, second], settings).values()], [
    'sub-01/ses-01/anat/sub-01_ses-01_run-1_FLAIR',
    'sub-01/ses-01/anat/sub-01_ses-01_run-2_FLAIR',
  ]);
});

test('omit preserves slice timing orientation and technical encoding metadata without identifiers', async () => {
  const item = await acquisition('T1w', { metadata: {
    SliceTiming: [0.5, 0], SliceEncodingDirection: 'k-', EchoTrainLength: 16,
    InPlanePhaseEncodingDirectionDICOM: 'COL', PatientName: 'PRIVATE', InstitutionName: 'PRIVATE',
  } });
  const { entries, paths } = await buildDataset([item], settings);
  const metadata = json(entries, `${paths.get(item.id)}.json`);
  assert.deepEqual(metadata.SliceTiming, [0.5, 0]);
  assert.equal(metadata.SliceEncodingDirection, 'k-');
  assert.equal(metadata.EchoTrainLength, 16);
  assert.equal(metadata.InPlanePhaseEncodingDirectionDICOM, 'COL');
  assert.equal(metadata.PatientName, undefined);
  assert.equal(metadata.InstitutionName, undefined);
});

test('reassigning diffusion to anatomy refuses hidden gradient sidecars without deleting them', async () => {
  const item = await acquisition('dwi', { bval: '0', bvec: '0\n0\n0' });
  for (const type of ['T1w', 'T2w', 'FLAIR']) {
    item.type = type;
    assert.ok(validateDataset([item], settings).some(error => error.field === 'type' && /clear its gradients/.test(error.message)));
    await assert.rejects(buildDataset([item], settings), /highlighted/);
    assert.equal(item.bval, '0');
    assert.equal(item.bvec, '0\n0\n0');
  }
  item.type = 'dwi';
  assert.deepEqual(validateDataset([item], settings), []);
});

test('classic and enhanced non-magnitude components stay excluded and cannot be confirmed into anatomy', async () => {
  for (const metadata of [
    { ImageType: ['ORIGINAL', 'PRIMARY', 'P', 'ND'] },
    { ImageType: ['ORIGINAL', 'PRIMARY', 'PHASE'] },
    { ImageType: 'ORIGINAL\\PRIMARY\\P\\ND' },
    { ImageType: ['ORIGINAL', 'PRIMARY', 'R'] },
    { ImageType: ['ORIGINAL', 'PRIMARY', 'IMAGINARY'] },
    { ComplexImageComponent: 'PHASE' },
    { ComplexImageComponent: 'MAGNITUDE', ImageType: ['ORIGINAL', 'PRIMARY', 'P'] },
  ]) {
    const item = await acquisition('T1w', { metadata: { SeriesDescription: 'MPRAGE', ...metadata } });
    const [suggested] = await seriesFromOutputs([item.image, new File([JSON.stringify(item.metadata)], 'scan.json')]);
    assert.equal(suggested.type, 'exclude', JSON.stringify(metadata));
    assert.ok(validateDataset([item], settings).some(error => /Only magnitude/.test(error.message)), JSON.stringify(metadata));
  }
  const magnitude = await acquisition('T1w', { metadata: { ImageType: ['ORIGINAL', 'PRIMARY', 'M', 'ND'] } });
  assert.deepEqual(validateDataset([magnitude], settings), []);
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

test('vectors allow rounding error, with zero vectors reserved for low-b volumes', async () => {
  const item = await acquisition('dwi', { volumes: 2, bval: '0 1000', bvec: '0 0.707107\n0 0.707107\n0 0' });
  assert.deepEqual(validateDataset([item], settings), []);
  for (const bvec of ['0 0.91\n0 0\n0 0', '0 1.09\n0 0\n0 0', '0.5 1\n0 0\n0 0', '2 1\n0 0\n0 0']) {
    assert.ok(validateDataset([{ ...item, bvec }], settings).some(error => error.field === 'gradients'), bvec);
  }
  assert.deepEqual(validateDataset([{ ...item, bvec: '1 1\n0 0\n0 0' }], settings), []);
});

test('reverse fieldmaps name actual DWI targets and identify both forward and reverse B0 sources', async () => {
  const dwi = { ...await acquisition('dwi', { volumes: 2, bval: '0 1000', bvec: '0 1\n0 0\n0 0', metadata: { PhaseEncodingDirection: 'j', TotalReadoutTime: 0.05 } }), id: 'dwi' };
  const reverse = { ...await acquisition('epi', { metadata: { PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.05 } }), id: 'reverse', direction: 'jminus', targets: ['dwi'] };
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

test('multi-echo anatomy receives echo entities, and repeated multi-echo runs keep both', async () => {
  const first = await acquisition('T1w', { metadata: { EchoNumber: 1 }, name: 'mprage_e1' });
  const second = { ...await acquisition('T1w', { metadata: { EchoNumber: 2 }, name: 'mprage_e2' }), id: 'series2' };
  assert.deepEqual([...datasetPaths([first, second], settings).values()], [
    'sub-01/ses-01/anat/sub-01_ses-01_echo-1_T1w',
    'sub-01/ses-01/anat/sub-01_ses-01_echo-2_T1w',
  ]);
  const repeat = [first, second].map((item, index) => ({ ...item, id: `repeat${index}` }));
  assert.deepEqual([...datasetPaths([first, second, ...repeat], settings).values()], [
    'sub-01/ses-01/anat/sub-01_ses-01_run-1_echo-1_T1w',
    'sub-01/ses-01/anat/sub-01_ses-01_run-1_echo-2_T1w',
    'sub-01/ses-01/anat/sub-01_ses-01_run-2_echo-1_T1w',
    'sub-01/ses-01/anat/sub-01_ses-01_run-2_echo-2_T1w',
  ]);
  const unflagged = await acquisition('T1w', { name: 'memprage_e1' });
  const pair = [unflagged, { ...second, id: 'series3' }];
  assert.deepEqual([...datasetPaths(pair, settings).values()], [
    'sub-01/ses-01/anat/sub-01_ses-01_echo-1_T1w',
    'sub-01/ses-01/anat/sub-01_ses-01_echo-2_T1w',
  ]);
  const single = { ...first, id: 'single' };
  assert.deepEqual([...datasetPaths([first, single], settings).values()], [
    'sub-01/ses-01/anat/sub-01_ses-01_run-1_T1w',
    'sub-01/ses-01/anat/sub-01_ses-01_run-2_T1w',
  ]);
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
