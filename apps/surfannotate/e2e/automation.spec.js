import { test, expect } from '@playwright/test';

const octahedron = 'v 1 0 0\nv -1 0 0\nv 0 1 0\nv 0 -1 0\nv 0 0 1\nv 0 0 -1\nf 1 3 5\nf 3 2 5\nf 2 4 5\nf 4 1 5\nf 3 1 6\nf 2 3 6\nf 4 2 6\nf 1 4 6\n';
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

test('surface operation indexes real geometry and exposes its actual viewer and regions', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'octahedron.obj', mimeType: 'text/plain', buffer: Buffer.from(octahedron) });
  await dispatch(page, 'adopt', { role: 'surfaces' });
  await dispatch(page, 'start');
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state).toBe('succeeded');
  const { report } = await dispatch(page, 'snapshot');
  expect(report.summary.surfaces[0]).toMatchObject({ sourceFile: 'octahedron.obj', numVertices: 6, numTriangles: 8, active: true });
  expect(report.artifacts).toEqual({});
  const viewers = await dispatch(page, 'viewers.list');
  expect(viewers[0]).toMatchObject({ id: 'main', capabilities: { tabs: true, regions: true, crosshair: false } });
  const state = await dispatch(page, 'viewers.state', { viewerId: 'main' });
  expect(state.tabs[0]).toMatchObject({ label: 'octahedron.obj', active: true });
  expect(await dispatch(page, 'viewers.regions', { viewerId: 'main' })).toEqual([]);
});
