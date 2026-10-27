import { awaitPipelineStep, createDicomConverter, createNiivueAdapter, registerAppAutomation, summarizeLabels } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { VERSION } from './app/config.js';
import { segmentRequest } from './app/request.js';
import { LEGACY_ASSETS, NETWORK_ASSETS } from '../vendor/seedseg/src/assets.js';

const distinct = values => values.length > 0 && new Set(values).size === values.length;

export function registerSeedSegAutomation(app) {
  const automation = registerAppAutomation({
    app: 'seedseg',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.js', document.baseURI).href }),
    operations: {
      segment: async ({ inputs, parameters, signal, progress }) => {
        const executor = app.inferenceExecutor;
        if (executor.isRunning()) throw new Error('SeedSeg is already processing an image.');
        const request = segmentRequest(parameters);
        const legacy = request.model === 'v1';
        if (legacy && !distinct(request.models)) throw new Error('Select one or more distinct SeedSeg v1 models.');
        if (!legacy && !distinct(request.folds)) throw new Error('Select one or more distinct SeedSeg networks.');
        const previousProgress = executor.setProgress;
        executor.setProgress = (value, message) => {
          previousProgress.call(executor, value, message);
          progress({ value, message });
        };
        try {
          await app.fileIOController.setFile(inputs.image[0]);
          signal.throwIfAborted();
          document.getElementById('legacyModel').checked = legacy;
          NETWORK_ASSETS.forEach(asset => { document.getElementById(`fold${asset.fold}`).checked = request.folds.includes(asset.fold); });
          document.getElementById('mirrorTTA').checked = request.mirror;
          document.getElementById('probThreshold').value = String(parameters.threshold);
          document.getElementById('nMarkers').value = String(parameters.markers);
          await awaitPipelineStep(executor, { terminal: 'complete' }, () => app.runSegmentation({ legacyModels: request.models }), signal);
          const markerStage = legacy ? 'consensus' : 'markers';
          const artifacts = [];
          for (const [stage, result] of Object.entries(executor.getResults())) {
            if (stage === 'input' || !result.file) continue;
            artifacts.push({ id: stage, role: stage === markerStage ? 'markers' : 'probability', file: result.file });
          }
          const markers = executor.getResult(markerStage)?.file;
          if (!markers) throw new Error(`SeedSeg did not return its ${markerStage} marker mask.`);
          const k = parameters.markers;
          const lookup = legacy
            ? { I: [0, 1], labels: ['Background', 'Fiducial marker'] }
            : { I: Array.from({ length: k + 1 }, (_, i) => i), labels: ['Background', ...Array.from({ length: k }, (_, i) => `Marker ${i + 1}`)] };
          const measurements = summarizeLabels(await readNifti(await markers.arrayBuffer()), lookup);
          const used = legacy
            ? LEGACY_ASSETS.filter(asset => request.models.includes(asset.seed))
            : NETWORK_ASSETS.filter(asset => request.folds.includes(asset.fold));
          return {
            artifacts,
            measurements: legacy ? measurements : { ...measurements, detections: executor.metrics },
            provenance: {
              appVersion: VERSION,
              model: legacy ? 'v1' : 'v2',
              models: used.map(asset => ({ name: asset.filename, url: asset.url, sha256: asset.sha256 })),
              executionProvider: legacy ? 'wasm' : executor.metrics?.backend,
              settings: executor.lastRunSettings.settings,
            },
          };
        } finally {
          executor.setProgress = previousProgress;
        }
      },
    },
  });
  automation.registerViewer('main', createNiivueAdapter(app.nv));
  return automation;
}
