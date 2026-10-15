---
"white-matter-lesions": patch
"brain-extraction": patch
---

Run SynthStrip brain extraction through the streamed browser session, layer by layer in slabs,
as SYNcro does. An image covering a whole head at 1 mm conforms to SynthStrip's 256³ grid, where
one whole-graph ONNX Runtime session ran out of WebAssembly memory with "std::bad_alloc".
The streamed session reproduces the recorded browser SynthStrip mask bit for bit.
