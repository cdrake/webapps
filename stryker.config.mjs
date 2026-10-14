// One module per run, chosen by MUTATION_MODULE; scripts/report-mutations.mjs
// runs every module in scripts/lib/mutation-modules.mjs in turn.
import { moduleById, strykerConfig } from './scripts/lib/mutation-modules.mjs';

export default strykerConfig(moduleById(process.env.MUTATION_MODULE));
