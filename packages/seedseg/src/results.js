export function outputNames(model, modelCount) {
  const stages = model === 'v2'
    ? ['probability', 'markers']
    : [...Array.from({ length: modelCount }, (_, i) => `model${i + 1}`), 'avgProb', 'consensus'];
  return Object.fromEntries(stages.map(stage => [stage, `${stage}.nii`]));
}
