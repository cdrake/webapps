---
"fastprep": patch
---

The technical log now shows MindGrab's own output for the brain extraction and tissue segmentation steps: which backend ran (WebGPU, WebGL2 or CPU), its timing, and warnings such as "the network found no brain". Before, a failed step reported only "the mindmap module exited with status 1".

The desktop suite's hosted runners no longer run fastprep's offline workflow: their software WebGL2 gives MindGrab a blank brain and ends the tissue segmentation with status 1. fastprep joins the apps whose workflow is validated on a hardware GPU, as its registry entry already declares.
