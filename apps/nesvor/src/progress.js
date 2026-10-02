const labels = {
  preparing: 'Preparing stacks',
  segmentation: 'Brain masking',
  'segmentation-model-download': 'Downloading brain masking model',
  'segmentation-warmup': 'Compiling GPU kernels and masking the first slice',
  'segmentation-backend': 'Brain masking ready',
  'segmentation-model-init': 'Initializing brain masking model',
  'bias-correction': 'N4 bias correction',
  'n4-runtime-download': 'Downloading N4 runtime',
  'n4-runtime-ready': 'N4 runtime ready',
  'svort-model-download': 'Downloading SVoRT model',
  'svort-model-init': 'Initializing SVoRT model',
  'svort-model': 'SVoRT models ready',
  svort: 'SVoRT motion correction',
  'stack-registration': 'Rigid stack registration',
  'training-setup': 'Preparing training data and GPU kernels',
  training: 'Training',
  'training-batch': 'Training',
  'support-mask': 'Building output mask',
  sampling: 'Reconstructing output voxels',
  complete: 'Reconstruction complete',
};

export function formatProgress(event) {
  const parts = [labels[event.stage] || event.stage || 'Browser reconstruction'];
  if (event.model !== undefined) parts.push(`model ${event.model + 1}`);
  if (event.stack !== undefined) parts.push(`stack ${event.stack + 1}${event.stacks ? `/${event.stacks}` : ''}`);
  if (event.iterations) parts.push(`iteration ${event.iteration ?? event.step}/${event.iterations}`);
  else if (event.iteration !== undefined) parts.push(`iteration ${event.iteration}${event.total ? `/${event.total}` : ''}`);
  if (event.phase) parts.push(event.phase);
  if (event.received !== undefined) {
    const mb = bytes => (bytes / 1048576).toFixed(1);
    parts.push(`${mb(event.received)}${event.total ? `/${mb(event.total)}` : ''} MB`);
  } else if (event.completed !== undefined && event.total !== undefined) {
    parts.push(`${event.completed}/${event.total}${event.stage === 'training-batch' ? ' observations' : ' completed'}`);
  }
  if (event.level !== undefined) parts.push(`level ${event.level}`);
  const loss = event.losses?.MSE ?? event.loss;
  if (Number.isFinite(loss)) parts.push(`loss ${loss.toPrecision(4)}`);
  if (event.message) parts.push(event.message);
  return parts.join(' · ');
}

// Keep the live status current, but bound console writes during fast GPU runs.
export function createProgressReporter({ display, log, now = Date.now }) {
  const started = now();
  let updated = started;
  let written = -Infinity;
  let key;
  let lastMessage = 'Preparing stacks';
  const history = [];
  function write(message) {
    written = now();
    const line = `[${((written - started) / 1000).toFixed(1)}s] ${message}`;
    history.push(line);
    if (history.length > 5000) history.shift();
    log(line);
  }
  return {
    update(event) {
      const message = formatProgress(event);
      const nextKey = `${event.stage === 'training-batch' ? 'training' : event.stage}:${event.phase ?? ''}`;
      const completed = event.stage === 'complete' || (event.step === event.iterations && event.iterations !== undefined);
      if (key !== nextKey || completed || now() - written >= 3000) write(message);
      key = nextKey;
      updated = now();
      lastMessage = message;
      display(message, Number.isFinite(event.fraction) ? Math.max(0, Math.min(1, event.fraction)) : undefined);
    },
    checkQuiet() {
      if (now() - updated >= 15000 && now() - written >= 15000) {
        write(`No new worker update for ${Math.floor((now() - updated) / 1000)}s. Last report: ${lastMessage}`);
      }
    },
    text() { return history.join('\n'); },
  };
}
