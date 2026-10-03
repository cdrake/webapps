---
"lcmodel": minor
"@neurodesk/lcmodel": patch
---

Fit groups of datasets and print a report of every fit. Dropping several acquisitions, or choosing a folder of subjects, fits them one after the other with the same settings, each with its recommended basis set unless a chosen library set suits all of them or a .BASIS file was dropped. A dataset that fails, or a file that cannot be read, is listed with its error and the rest continue; the footer × stops the run and keeps the finished fits. The group table in the viewer lists each dataset's concentrations or ratios with %SD and the FID-A and LCModel quality numbers; selecting a dataset shows its fit. It downloads as a long CSV (one row per dataset and metabolite, with unit and ratio reference on every row), a wide CSV and a zip of reports. Each fit has a self-contained, printable HTML report in place of LCModel's PostScript page. Spectra in separate subject folders now pair with the water reference in their own folder, and the `fit-group` automation operation returns the group table and the reports. New example: Osprey's two-subject Philips PRESS data.
