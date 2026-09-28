import { PipelineExecutor } from '@neurodesk/webapp-components';
import { VERSION } from '../app/config.js';

export class MuscleMapPipeline extends PipelineExecutor {
  constructor(options = {}) {
    super({
      ...options,
      workerUrl: `js/inference-worker.js?v=${VERSION}`,
      workerType: 'module',
      version: VERSION,
      steps: [],
    });
    this.pendingTask = null;
    this.currentTaskType = null;
    const onComplete = this.onComplete;
    const onError = this.onError;
    this.onComplete = data => {
      this.pendingTask?.resolve(true);
      this.pendingTask = null;
      this.currentTaskType = null;
      onComplete(data);
    };
    this.onError = message => {
      this.pendingTask?.reject(new Error(message));
      this.pendingTask = null;
      this.currentTaskType = null;
      onError(message);
    };
  }

  async runTask(type, config) {
    if (this.pendingTask) throw new Error('A MuscleMap task is already running.');
    this.currentTaskType = type;
    const labels = {
      run: 'Starting segmentation...',
      metricsOnly: 'Calculating metrics...',
      consolidateOnly: 'Consolidating segmentations...',
    };
    this.updateOutput(labels[type] || `Starting ${type}...`);
    const completion = new Promise((resolve, reject) => { this.pendingTask = { resolve, reject }; });
    // Cancellation may arrive while worker initialization is still pending.
    void completion.catch(() => {});
    try {
      await this.executeCommand(type, config, { clearResults: true });
      return await completion;
    } catch (error) {
      this.pendingTask = null;
      this.currentTaskType = null;
      throw error;
    }
  }

  run(config) { return this.runTask('run', config); }
  calculateMetrics(config) { return this.runTask('metricsOnly', config); }
  consolidateSegmentations(config) { return this.runTask('consolidateOnly', config); }

  cancel() {
    const pending = this.pendingTask;
    this.pendingTask = null;
    this.currentTaskType = null;
    super.cancel();
    pending?.reject(new Error('Cancelled'));
  }
}
