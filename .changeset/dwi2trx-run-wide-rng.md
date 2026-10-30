---
"dwi2trx": patch
---

Give every seed its own random stream across the whole run. Each 10,000-seed batch used to reuse the first batch's bootstrap random streams, and a retry after running out of GPU memory, which uses smaller batches, changed which stream each seed got. Streams now follow a seed's position in the run, so the batch size no longer changes the streamlines. Runs of up to 10,000 seeds give the same output as before; larger runs change from the 10,001st seed on.
