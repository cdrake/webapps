# dicom2bids

## 0.1.20261018

### Minor Changes

- b67e4e9: Add DICOM to BIDS (`dicom2bids`), a browser-only catalog app that runs dcm2niix on one MRI examination at a time. Accept files, folders and ZIP archives; review anatomical, diffusion and reverse phase encoding acquisitions; enter missing metadata; and download an organized BIDS dataset with an explicit identifying-metadata policy. Preserve separate acquisitions and image/gradient ordering, and link reverse EPI fieldmaps to their DWI targets.

  Share bounded conversion deadlines, NIfTI text removal, report-form styling and in-memory automation reset. Include a pinned DICOM example, Philips native-reference checks and offline/interface workflow coverage.

### Patch Changes

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/dicom2vid@0.5.20261018
