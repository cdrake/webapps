# disconnectome

## 0.1.20260930

### Patch Changes

- Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.5.2
  - @neurodesk/nii2tvx@0.1.20260930

## 0.1.20260924

### Patch Changes

- Updated dependencies [39a9ea5]
  - @neurodesk/webapp-components@0.4.5
  - @neurodesk/nii2tvx@0.1.20260924

## 0.1.20260923

### Patch Changes

- Disconnectome gains the shared Support action along with every other webapp. It
  merged after the release that recorded the action for the other 25 apps, so this
  notes it against the same release date.
  - @neurodesk/nii2tvx@0.1.20260923

### Patch Changes

- c8a0be2: New app: Disconnectome scores which white-matter bundles a lesion disconnects, intersecting the lesion with a population tractography atlas in WebAssembly and drawing the damaged bundles coloured by a viridis ramp over their damage. Two atlases are selectable, the 65-bundle ENIGMA Symmetric atlas by default and the 87-bundle HCP1065 atlas; each downloadable TSV is byte-identical to the nii2tvx command-line tool for that atlas.
- Convert DICOM anatomy through the shared importer and preserve the previous inputs when an example is cancelled. Complete the offline atlas inventory. Reject truncated tract files and invalid TCK headers, honor TCK data offsets, and report allocation failures without corrupting WebAssembly memory. Add native, browser, and offline regression checks.
- Updated dependencies [c8a0be2]
- Updated dependencies
  - @neurodesk/nii2tvx@0.1.20260923
