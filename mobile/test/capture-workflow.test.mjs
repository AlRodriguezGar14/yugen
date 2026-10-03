import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

test('direct camera shutter hands upright photo to OCR once and recovers from capture failure', async () => {
  const cameraSource = await readFile(new URL('../src/capture/CameraCapture.tsx', import.meta.url), 'utf8');
  const start = cameraSource.indexOf('  async function takePhoto(');
  const snippet = cameraSource.slice(start, cameraSource.indexOf('  return (', start));
  assert.ok(snippet.includes('capturePhotoToFile'), 'The shutter must capture directly without the system photo approval');
  let captures = 0;
  let busy = false;
  let error = null;
  let failCapture = false;
  let finishImport;
  let enteredImport;
  const importing = new Promise((resolve) => { finishImport = resolve; });
  const entered = new Promise((resolve) => { enteredImport = resolve; });
  const photos = [];
  const takingPhoto = { current: false };
  const deps = {
    ready: true, takingPhoto,
    photoOutput: { capturePhotoToFile: async (settings) => {
      assert.equal(settings.enableShutterSound, false, 'The shutter requests no system sound (the OS may still enforce it)');
      captures += 1;
      if (failCapture) throw new Error('Camera capture failed');
      return { filePath: '/tmp/portrait.jpg' };
    } },
    Image: { getSize: (_uri, success) => success(3000, 4000) },
    setBusy: (value) => { busy = value; }, setError: (value) => { error = value; },
    onPhoto: async (asset) => { photos.push(asset); enteredImport(); await importing; },
  };
  const takePhoto = new Function(...Object.keys(deps), `${stripTypeScriptTypes(snippet)}\nreturn takePhoto;`)(...Object.values(deps));
  const first = takePhoto();
  await entered;
  await takePhoto();
  assert.equal(captures, 1, 'A double tap during capture/import must not take another photo');
  assert.equal(busy, true);
  assert.deepStrictEqual(photos[0], { uri: 'file:///tmp/portrait.jpg', width: 3000, height: 4000, fileName: 'portrait.jpg', mimeType: 'image/jpeg', type: 'image' });
  finishImport();
  await first;
  assert.equal(busy, false);
  assert.equal(takingPhoto.current, false);
  failCapture = true;
  await takePhoto();
  assert.match(error, /could not be captured/);
  assert.equal(busy, false);
  assert.equal(takingPhoto.current, false, 'A capture failure must leave the shutter retryable');
});
