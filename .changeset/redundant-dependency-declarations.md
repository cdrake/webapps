---
---

Remove dependency declarations that nothing resolves through: the per-app `eslint` devDependencies (linting runs the root's ESLint), the root's `ajv` and `ajv-formats` (only the desktop workspace imports them), node-drivers' `vite`, VesselBoost's `onnxruntime-node` and `jsdom`, SCT's `nifti-reader-js` and dwi2trx's `fflate` (bundled through `@dipy/gpu-streamlines`, which declares it). No locked package version changes, and app bundles are unchanged.
