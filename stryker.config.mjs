// One module per run, chosen by MUTATION_MODULE; scripts/report-mutations.mjs
// runs every module in scripts/lib/mutation-modules.mjs in turn. Without the
// variable (a bare `stryker run`, or tools such as Knip that load this file)
// the config is the smoke canary's module.
import { moduleById, smoke, strykerConfig } from './scripts/lib/mutation-modules.mjs';

export default strykerConfig(moduleById(process.env.MUTATION_MODULE || smoke.module));
