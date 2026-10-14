import { LABEL_SPACES, MODELS } from './model-catalog.generated.js';

export const MODEL_LABELS = Object.fromEntries(
  [...MODELS].reverse().map(model => [model.filename, model.labelSpace.labels])
);

export const LABELS = MODELS[0].labelSpace.labels;

export function getLabelsForModel(modelName) {
  return MODEL_LABELS[modelName] || LABELS;
}

export function getLabelsForLabelSpace(labelSpaceId) {
  return LABEL_SPACES[labelSpaceId]?.labels || null;
}

function hslToRgba(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r;
  let g;
  let b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
    255
  ];
}

function generateColors(labels) {
  for (let index = 1; index < labels.length; index++) {
    const hue = ((index - 1) * 137.508) % 360;
    const saturation = 65 + (index % 3) * 12;
    const lightness = 40 + (index % 5) * 7;
    labels[index].color = hslToRgba(hue, saturation, lightness);
  }
}

for (const labelSpace of Object.values(LABEL_SPACES)) generateColors(labelSpace.labels);

export function getLabelName(index, labels) {
  const labelArray = labels || LABELS;
  return labelArray[index]?.name || `Label ${index}`;
}

export function getLabelColor(index, labels) {
  const labelArray = labels || LABELS;
  return labelArray[index]?.color || [128, 128, 128, 255];
}

export function generateNiivueColormap(labels) {
  const labelArray = labels || LABELS;
  const size = 256;
  const R = new Array(size).fill(0);
  const G = new Array(size).fill(0);
  const B = new Array(size).fill(0);
  const A = new Array(size).fill(0);

  for (let index = 0; index < labelArray.length && index < size; index++) {
    const color = labelArray[index].color;
    if (!color) continue;
    R[index] = color[0];
    G[index] = color[1];
    B[index] = color[2];
    A[index] = index === 0 ? 0 : 255;
  }

  return { R, G, B, A };
}

export function getMuscleLabels(labels) {
  const labelArray = labels || LABELS;
  return labelArray.slice(1);
}
