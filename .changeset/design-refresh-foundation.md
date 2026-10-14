---
"@neurodesk/webapp-components": minor
"musclemap": minor
"niimath": patch
"ants": patch
"brain-extraction": patch
"brain2print": patch
"browserqc": patch
"calmar": patch
"carotid-flow": patch
"deface": patch
"dicom2vid": patch
"disconnectome": patch
"dwi2trx": patch
"easy-mp2rage": patch
"edgereg": patch
"elastix": patch
"fireants": patch
"greedy": patch
"lcmodel": patch
"nesvor": patch
"qsmbly": patch
"seedseg": patch
"spinalcordtoolbox": patch
"surfannotate": patch
"syncro": patch
"synthseg": patch
"synthsr": patch
"topofit": patch
"vesselboost": patch
"white-matter-lesions": patch
---

Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
focus and selection only, a compact 48px app bar, sentence-case section titles
and a quieter status bar. The example menu is now the input control: examples,
then Choose files… and Choose folder…. The whole window, the viewer included,
accepts dropped files; a drop mid-session replaces the inputs with Undo in the
status bar. Before any input the status reads "Drag and drop files". MuscleMap
drops its separate drop box and Add File(s) button.

Page drops fill empty image slots in order while keeping DICOM series together.
New selections supersede unfinished drop traversal, and registration apps load
each dropped image in order. The shared drop handler also respects the different
native input and file-field event contracts.
Failed imports leave only successfully loaded slots occupied, and Undo can
restore loaded examples.
