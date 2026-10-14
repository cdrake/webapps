// The web app's niimath and MindGrab runtimes, shaped for pipeline.js: niimath's vendored
// WebAssembly worker running the pipeline's argv, and the shared MindGrab runtime, which resolves
// `auto` to a hardware GPU or the threaded CPU module and runs each call in its own worker.
export { createNiimathCommand } from '@neurodesk/runtime-support/niimath/command';
export { mindgrab } from '@neurodesk/runtime-support/mindgrab';
