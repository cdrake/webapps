// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: "pipelines",
  version: "0.0.20261022",
});

// The vendored NeuroFlow validator (vendor/neuroflow/README.md).
export const VALIDATOR = Object.freeze({
  source: "cdrake/neuroflow",
  commit: "255548d47cc35ed3a54c30f534ef3f1b1f67eac3",
  sha256: "dbf3df39ebb2aa52b7908c81aee8a157be88a2918bec031b8527dacedae92b25",
});

// Where the build writes the NeuroFlow bundle (scripts/catalog.mjs), relative to the page.
export const BUNDLE = "neuroflow/neuroflow-registry.json";
