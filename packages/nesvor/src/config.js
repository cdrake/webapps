import { DEFAULTS } from './training/index.js';

export function browserConfig(request) {
  if (!Array.isArray(request.stacks) || !request.stacks.length || request.stacks.length > 20) throw new Error('Supply one to twenty MRI stacks.');
  for (const stack of request.stacks) {
    if (!(stack.image instanceof ArrayBuffer) || (stack.mask !== undefined && !(stack.mask instanceof ArrayBuffer))) throw new Error('Stacks and masks must be NIfTI buffers.');
    if (!(stack.thickness > 0 && stack.thickness <= 30) || !Number.isFinite(stack.thickness)) throw new Error('Confirm the physical slice thickness for every stack.');
  }
  const options = request.options ?? {};
  const registration = options.registration ?? 'svort';
  if (!['none', 'stack', 'svort', 'svort-only', 'svort-stack'].includes(registration)) throw new Error('Select a supported motion correction method.');
  const config = { ...DEFAULTS, registration, deformable: Boolean(options.deformable), ...Object.fromEntries(['iterations', 'batchSize', 'weightImage', 'weightTransformation', 'weightDeform'].filter((key) => options[key] !== undefined).map((key) => [key, options[key]])), log2Size: options.log2HashmapSize ?? DEFAULTS.log2Size, outputResolution: options.outputResolution ?? 0.8 };
  for (const [key, minimum, maximum, integer] of [['iterations',1,20000,true],['batchSize',1,32768,true],['log2Size',3,24,true],['outputResolution',0.3,10,false],['weightImage',0,100,false],['weightTransformation',0,100,false],['weightDeform',0,100,false]]) {
    if (!Number.isFinite(config[key]) || config[key] < minimum || config[key] > maximum || (integer && !Number.isSafeInteger(config[key]))) throw new Error(`Invalid browser reconstruction setting: ${key}.`);
  }
  return config;
}

