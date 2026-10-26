---
"seedseg": patch
---

Merge upstream astewartau/prostate 3354f6c..c9b328a:

- Web app and Python deploy pipeline for the nnU-Net fold ensemble
- Web app: ONNX Runtime Web 1.30
- Web app: WebGPU first with WASM fallback; neutral network selection
- Web app: legacy v1 model under Advanced; models bundled from OSF; JSEP WebGPU
- Deploy scripts: WebGPU-compatible graph rewrite, int8 and compression evaluation
- rewrite_for_webgpu: AveragePool as Reshape + ReduceMean
- Deploy workflow: final checksums of the browser model files; runner flags
- Deploy workflow: OSF ids of the v2 browser model files
- Load all models from the Hugging Face repo ash347/seedseg at a pinned commit; checksum the legacy models too
- Merge pull request #1 from astewartau/v2-deploy
- chore: bump version to 0.3.0
- Training, evaluation and label code for the nnU-Net model (patient identifiers replaced by study codes)
- Replace the remaining patient identifiers with study codes
- Merge pull request #2 from astewartau/v2
- seedseg_onnx: lazy option creates each network's session only while it runs
- Merge pull request #3 from astewartau/lazy-gpu-sessions
