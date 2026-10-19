# dicom2bids

## 0.1.20261019

### Patch Changes

- Updated dependencies [af2e8db]
- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/dicom2vid@0.5.20261019
- ac0b4e9: Keep anatomical filenames free of direction entities after review edits, preserve slice-timing orientation and technical encoding metadata in privacy-filtered exports, and reject classic DICOM phase/real/imaginary images. Refuse anatomical exports with attached diffusion gradients until the user reassigns the scan or clears them. Report missing or malformed automation assignments clearly and classify the app as Vite with WebAssembly.
- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2

## 0.1.20261018

### Minor Changes

- b67e4e9: Add DICOM to BIDS (`dicom2bids`), a browser-only catalog app that runs dcm2niix on one MRI examination at a time. Accept files, folders and ZIP archives; review anatomical, diffusion and reverse phase encoding acquisitions; enter missing metadata; and download an organized BIDS dataset with an explicit identifying-metadata policy. Preserve separate acquisitions and image/gradient ordering, and link reverse EPI fieldmaps to their DWI targets.

  Share bounded conversion deadlines, NIfTI text removal, report-form styling and in-memory automation reset. Include a pinned DICOM example, Philips native-reference checks and offline/interface workflow coverage.

### Patch Changes

- Updated dependencies [7c0d201]
  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/dicom2vid@0.5.20261018
- a560d01: Invalidate confirmation while replacement gradients load, keep the latest edit when reads overlap, and block export until the edit settles. Reject materially non-unit b-vectors without changing the supplied values.
- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/dicom2vid@0.5.20261018
