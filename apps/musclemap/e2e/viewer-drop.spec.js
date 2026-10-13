import { expect, test } from '@playwright/test';

function createInt16Nifti(values, voxelSize = [10, 10, 10]) {
  const headerSize = 352;
  const buffer = Buffer.alloc(headerSize + values.length * 2);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, values.length, true);
  view.setInt16(44, 1, true);
  view.setInt16(46, 1, true);
  view.setInt16(48, 1, true);
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  view.setFloat32(80, voxelSize[0], true);
  view.setFloat32(84, voxelSize[1], true);
  view.setFloat32(88, voxelSize[2], true);
  view.setFloat32(108, headerSize, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, voxelSize[0], true);
  view.setFloat32(300, voxelSize[1], true);
  view.setFloat32(320, voxelSize[2], true);
  buffer.write('n+1\0', 344, 'binary');
  values.forEach((value, index) => view.setInt16(headerSize + index * 2, value, true));
  return buffer;
}

async function dropNifti(page, target, name) {
  const bytes = Array.from(createInt16Nifti([10, 20, 30]));
  const box = await target.boundingBox();
  await target.dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(([fileName, fileBytes]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(fileBytes)], fileName, { type: 'application/octet-stream' }));
      return transfer;
    }, [name, bytes]),
    bubbles: true,
    cancelable: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2
  });
}

for (const [label, selector] of [
  ['the sidebar drop zone', '#fileDropZone'],
  ['the NiiVue canvas', '#gl1'],
  ['the technical log', '#musclemap-log']
]) {
  test(`a NIfTI dropped on ${label} becomes the segmentation input`, async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#runSegmentation')).toBeDisabled();

    await dropNifti(page, page.locator(selector), 'subject_T1w.nii');

    await expect(page.locator('#fileList .file-name')).toHaveText(['subject_T1w.nii']);
    await expect(page.locator('#runSegmentation')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.app.fileIOController.getActiveFile()?.name)).toBe('subject_T1w.nii');
  });
}
