// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: "pipelines",
  version: "0.0.20261022",
});

// The vendored NeuroFlow validator (vendor/neuroflow/README.md).
export const VALIDATOR = Object.freeze({
  source: "cdrake/neuroflow",
  commit: "d3708b4031e4fa7d1686f41e1df7c2ec27f107e5",
  sha256: "dbf3df39ebb2aa52b7908c81aee8a157be88a2918bec031b8527dacedae92b25",
});

// Where the build writes the NeuroFlow bundle (scripts/catalog.mjs), relative to the page.
export const BUNDLE = "neuroflow/neuroflow-registry.json";
