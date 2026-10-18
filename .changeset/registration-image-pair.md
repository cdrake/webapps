---
"@neurodesk/webapp-components": minor
"ants": minor
"greedy": minor
"fireants": minor
"edgereg": minor
"elastix": minor
"syncro": minor
"@neurodesk/syncro": patch
---

The registration apps load their images through one shared fixed/moving pair
(`nd-image-pair`, `createImagePair`). Each app now says fixed and moving, never
stationary. The fixed card comes first. Each card has explicit "Load fixed
image…" / "Load moving image…" and "Folder…" pickers, a drop zone, a summary
of size and spacing, a series select and a clear ×, and Swap exchanges the two.
Examples fill the slots by role through the same path as a user's file, and a
failed load keeps the previous image. The fixed card offers built-in templates from
the new `registry/templates.json`: FSL MNI152 1 mm brain and head and the ICBM152
avg152 2 mm head, downloaded and checked with `fetchModel`, and cited in each app.
elastix offers them for 3D images only. SYNcro shows its MNI152 template as a
locked fixed image, its scan is the moving image, and it fetches the template from
the catalogue address. Brain extraction in ANTs, Greedy and FireANTs has its own
Fixed and Moving buttons below the pair.
