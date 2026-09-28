import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSurfaceFiles } from '../../../packages/topofit/src/results.js';
import { automationArtifacts } from '../src/automation-results.js';

test('all generated surfaces including registration geometry survive artifact export unchanged', async () => {
  const vertices = {};
  const faces = {};
  for (const side of ['lh', 'rh']) {
    for (const name of ['white', 'pial', 'registration']) vertices[`${side}.${name}`] = Float32Array.of(0,0,0, 1,0,0, 0,1,0);
    faces[side] = Int32Array.of(0,1,2);
  }
  const files = writeSurfaceFiles(vertices, faces);
  const artifacts = automationArtifacts(files);
  assert.equal(artifacts.length, 8);
  for (const [index, artifact] of artifacts.entries()) {
    assert.equal(artifact.role, files[index].id.endsWith('-registration') ? 'registration' : 'surface');
    assert.equal(artifact.file.name, files[index].name);
    assert.deepEqual(await artifact.file.arrayBuffer(), files[index].bytes);
  }
});

test('variable patch geometry and metadata preserve independent result identities', () => {
  const artifacts = automationArtifacts([
    { id: 'LH01', name: 'LH01.mid.white', mediaType: 'application/vnd.freesurfer.surface', bytes: Uint8Array.of(1) },
    { id: 'surface-analysis', name: 'analysis.json', mediaType: 'application/json', bytes: new TextEncoder().encode('{}') },
    { id: 'lh-normals', name: 'normals.csv', mediaType: 'text/csv', bytes: new TextEncoder().encode('x,y,z') },
  ]);
  assert.deepEqual(artifacts.map(({ id, role }) => ({ id, role })), [{ id: 'lh01', role: 'surface' }, { id: 'surface-analysis', role: 'metadata' }, { id: 'lh-normals', role: 'table' }]);
});
