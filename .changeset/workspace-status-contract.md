---
"ants": patch
"brain-extraction": patch
"calmar": patch
"carotid-flow": patch
"deface": patch
"dicom2vid": patch
"dicompare": patch
"disconnectome": patch
"dwi2trx": patch
"easy-mp2rage": patch
"fireants": patch
"greedy": patch
"musclemap": patch
"niimath": patch
"qsmbly": patch
"seedseg": patch
"spinalcordtoolbox": patch
"surfannotate": patch
"syncro": patch
"synthsr": patch
"topofit": patch
"vesselboost": patch
"zarro": patch
"@neurodesk/webapp-components": patch
---

Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.
