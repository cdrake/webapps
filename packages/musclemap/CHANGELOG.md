# @neurodesk/musclemap

## 1.5.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 1.5.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 1.5.20261010

### Minor Changes

- 98eb502: Share MuscleMap preprocessing, inference, labels and metrics between the browser and a portable CPU command line. Include all seven verified checkpoints, offline model and output guards, IMF options and browser/upstream parity checks on each supported platform. Replace the worker's CDN cache dependency with the shared verified model cache.

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
