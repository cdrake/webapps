// Each module is mutated against only the Node suite that specifies it. The
// command runner cannot map tests to files, so every mutant runs every suite.
export const modules = [
  {
    file: 'packages/nii2tvx/src/disconnectome.js',
    mutate: 'packages/nii2tvx/src/disconnectome.js',
    files: ['packages/nii2tvx/package.json', 'packages/nii2tvx/test/disconnectome.test.js'],
    command: 'node --test packages/nii2tvx/test/disconnectome.test.js',
  },
  {
    file: 'packages/lcmodel/src/basis-select.js',
    mutate: 'packages/lcmodel/src/basis-select.js',
    files: ['packages/lcmodel/package.json', 'packages/lcmodel/test/basis-select.test.js'],
    command: 'node --test packages/lcmodel/test/basis-select.test.js',
  },
  {
    // formatG only: the rest of index.js drives the WebAssembly module.
    file: 'packages/nii2tvx/src/index.js',
    mutate: 'packages/nii2tvx/src/index.js:24-35',
    files: ['packages/nii2tvx/package.json', 'packages/nii2tvx/wasm/nii2tvx.mjs', 'packages/nii2tvx/test/parity.test.js'],
    command: 'node --test --test-name-pattern=printf packages/nii2tvx/test/parity.test.js',
  },
];

// The PR canary: tableName, a small naming function in the first module.
export const smoke = { file: 'packages/nii2tvx/src/disconnectome.js', mutate: 'packages/nii2tvx/src/disconnectome.js:10-12' };

const sandbox = new Set(['package.json', ...modules.flatMap((module) => [module.file, ...module.files])]);

export default {
  mutate: modules.map((module) => module.mutate),
  ignorePatterns: ['**', ...[...sandbox].map((path) => `!${path}`)],
  testRunner: 'command',
  allowConsoleColors: false,
  clearTextReporter: { allowColor: false },
  commandRunner: { command: modules.map((module) => module.command).join(' && ') },
  coverageAnalysis: 'off',
  concurrency: 2,
  timeoutMS: 5000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'quality-artifacts/mutations/mutation.json' },
  htmlReporter: { fileName: 'quality-artifacts/mutations/index.html' },
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
