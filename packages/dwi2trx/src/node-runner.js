// The fresh-module Node runner bound to this package's dtifit-enabled niimath dependency.
import { runNiimath as run } from '@neurodesk/node-drivers/niimath';
import createNiimath from '@niivue/niimath/niimath.js';

export const runNiimath = (args, files) => run(createNiimath, args, files);
