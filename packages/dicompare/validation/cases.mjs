// The checks cli-check.mjs runs and browser-reference.mjs records. `browser` names the app's
// automation operation that produces the same report; build-schema has none, so its reference is
// the in-repository command line and the browser instead validates the example against it.
export const EXAMPLE = 't1-dicom-protocol';
export const LIBRARY_SCHEMA = 'QSM_Consensus_Guidelines_v1.0';

export const CASES = [
  { id: 'analyze', args: ['analyze'], browser: { operation: 'analyze', artifact: 'acquisitions' } },
  { id: 'compare-library', args: ['compare', '--schema', LIBRARY_SCHEMA],
    browser: { operation: 'compare', artifact: 'comparison', schema: 'library' } },
  { id: 'build-schema', args: ['build-schema'], browser: null },
  { id: 'compare-built-schema', args: ['compare', '--schema', '{build-schema}'],
    browser: { operation: 'compare', artifact: 'comparison', schema: 'build-schema' } },
];
