# Deformable reconstruction

`model.js` defines the optional NeSVoR deformation network: a smoothstep hash grid, per-slice embedding, two tanh hidden layers and a three-component displacement in normalized coordinates. The output is converted back to the supplied world-coordinate system. Defaults match NeSVoR 0.5.0.

`gpu.js` trains this network in WebGPU. Forward propagation carries a four-component jet for each activation: the value and its three spatial derivatives. Reverse propagation through those jets computes the parameter derivatives of the Jacobian regularizer analytically. It does not estimate derivatives with finite differences. Memory for activations is bounded by the network and microbatch sizes.

```js
const model = createDeformationModel({ boundingBox, slices });
const deformation = await createGPUDeformation(device, model);
const warped = await deformation.forward({ xyz, sliceIndices });
// Evaluate the image field at warped.xyz, then chain its coordinate cotangent.
const backward = await deformation.backward({
  xyz,
  sliceIndices,
  xyzGradient: imageCoordinateGradient,
  regularizationWeights,
}, { accumulate: false, signal });
await deformation.step(step, learningRate);
```

Coordinates and cotangents are `Float32Array(3*N)`; slice indices are `Uint32Array(N)`. `regularizationWeights` is `Float32Array(N)`. For the upstream objective, only the first `min(4, samples)` PSF samples of each observation receive a nonzero weight: `weightDeform / (batchSize * min(4, samples))`. The regularizer detaches its input coordinates and slice embeddings, exactly as upstream does. The image term still updates both. `backward.xyzGradient` chains to the rigid poses. Gradients accumulate over microbatches; call `step` once after the complete effective batch. Use `accumulate: true` for subsequent chunks of that batch.

The forward and backward results contain deformed `xyz` and the unweighted per-query `regularization`. `backward` additionally returns input-coordinate gradients. Set `readGradients: true` only for numerical verification; normal training keeps parameter gradients on the GPU. `readParameters()` returns arrays in model parameter order: the hash table, each layer's weights and biases, and the slice embedding. `dispose()` releases GPU resources.

Output reconstruction samples the main image field in its reference frame. It does not apply a slice-specific deformation to output-volume coordinates.

## Verification

Run the unit checks with:

```sh
node --test packages/nesvor/src/deformation/model.test.js
```

Run the independent upstream oracle and actual WebGPU comparison with:

```sh
node packages/nesvor/src/deformation/fixture.mjs "$TMPDIR/deformation-input.json"
"$TMPDIR/nesvor-export-venv/bin/python" packages/nesvor/src/deformation/export-oracle.py \
  --source "$TMPDIR/nesvor-source" \
  --input "$TMPDIR/deformation-input.json" \
  --output "$TMPDIR/deformation-oracle.json"
PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/playwright" node packages/nesvor/src/deformation/verify.mjs \
  "$TMPDIR/deformation-input.json" "$TMPDIR/deformation-oracle.json"
```

The oracle executes the actual upstream `DeformNet`, network builder, resolution calculation and `NeSVoR.deform_reg`. NeSVoR 0.5.0's CPU `HashEmbedder` rejects the `interpolation="Smoothstep"` argument passed by `DeformNet`. The oracle therefore supplies a disclosed subclass implementing the requested smoothstep interpolation. It does not claim an unchanged upstream CPU run or CUDA hash-layout parity. The browser uses the existing PyTorch hash-address layout, with smoothstep interpolation, and float32 arithmetic.

The fixture exercises hash collisions, nontrivial deformation, nonzero Jacobian regularization, detached embedding semantics and gradient accumulation. Chromium's software WebGPU adapter passes with maximum absolute errors against the torch oracle of 5.4e-7 for outputs, 4.7e-9 for input gradients, 3.0e-8 for parameter gradients and 3.4e-7 for the regularizer. The verifier also executes the default-width/default-hash-size architecture and verifies AdamW updates. Hardware performance and a full fetal-body reconstruction against CUDA remain separate integration checks.

The integrated trainer also has an upstream full-objective check:

```sh
PYTHONPATH="$TMPDIR/nesvor-source" "$TMPDIR/nesvor-export-venv/bin/python" \
  packages/nesvor/src/deformation/export-training-oracle.py \
  > "$TMPDIR/deformation-training.json"
PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/playwright" node \
  packages/nesvor/src/deformation/verify-training.mjs \
  "$TMPDIR/deformation-training.json"
```

This runs the upstream `NeSVoR.forward` with deformation enabled and compares the complete data, variance, image, pose and deformation losses, every parameter gradient, and one AdamW update against the browser's integrated `gpuTrainingStep`. The fixture uses five PSF samples, so it checks that the Jacobian regularizer uses only the first four. Observation chunks of one, two and three produce the same effective batch. The image regularizer uses deformed coordinates, while pose gradients propagate through the deformation network. The smoothstep encoder shim is the same disclosed compatibility repair described above.

The integrated comparison passes on Chromium software WebGPU with maximum absolute errors of 9.6e-8 for losses, 6.0e-8 for field/pose gradients, 2.3e-8 for deformation gradients and 7.5e-9 for updated parameters.
