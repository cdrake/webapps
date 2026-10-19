---
"dicomview": patch
---

The Open in White matter lesions check reads a gzipped NIfTI's header through the shared streaming decoder instead of a fixed 64 KB prefix, so a valid `.nii.gz` whose header lies past the first 64 KB of compressed data is no longer refused as uncheckable.
