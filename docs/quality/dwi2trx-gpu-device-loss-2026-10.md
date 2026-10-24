# DWI2TRX device-loss investigation

Issue [#598](https://github.com/neurodesk/webapps/issues/598) reports Intel/Mesa
Vulkan device loss during tracking of real DWI. The smaller pinned 21-volume
example succeeds on the same host. A targeted Apple/Metal run also reproduces the failure.

The provisioned hardware regression in `apps/dwi2trx/e2e/real-data.spec.js` uses
Philips ds007522 sub-HML0001 ses-01 from the immutable URLs, byte sizes and SHA-256
pins in `validation/dwi-vendors/sources.json`. It takes the central 72×72×39 crop
(origin 28,28,15) of the 128×128×69 grid, retaining all 136 frames. This matches a
reported failing **shape**; the report does not specify its crop origin. There is
no resampling. Values use the same scaled float32 representation the app reads;
the translated oblique affine and original gradient table are retained.

The crop requires about 110 MB of signal storage, rather than the full source's
615 MB. Passing this test does not establish full-size input support. CI provisions
it through `DWI2TRX_REAL_DWI_DIR` on the hardware-GPU runner. The test requires all
selected seeds to complete, rejects capped or truncated results, validates finite
TRX coordinates and output counts, rejects unexpected device loss, and performs
fresh device buffer IO afterward. The app intentionally destroys its private
tracking device when processing ends; that explicit destruction is allowed.

## Reproduced command timeout

The [baseline Metal diagnostic](https://github.com/neurodesk/webapps/actions/runs/40118569486)
records the initial count dispatch (`getNumStreamlinesBoot_k`, 5,000 workgroups)
and its successful 40,004-byte offsets readback after about 1.23 seconds. The
subsequent generation dispatch (`genStreamlinesMergeBoot_k`, 5,000 workgroups)
fails while reading its 385,680-byte streamline metadata after about 92.08
seconds. These are diagnostic timestamps, not benchmark results. The adapter is
Apple hardware, not a fallback adapter. Its exact device-loss message begins:

```text
Metal command buffer failed: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout) (domain=MTLCommandBufferErrorDomain, code=2)
```

This establishes a generation-command watchdog failure, rather than an initial
count-pass failure or an Intel-only limitation. The diagnostic saves dispatch
entry points, workgroup counts, readback source labels, device-loss messages and a
Playwright trace.

## Bounded physical commands

The local source pin at `apps/dwi2trx/vendor/gpu-streamlines` limits both passes
to 16 workgroups per command, waits for completion before changing the parameter
buffer, and yields to UI/abort tasks between commands. A 10,000-seed logical batch
uses 5,000 logical workgroups, hence 313 submissions per pass. The additional
submissions/yields are a deliberate overhead tradeoff against long uninterruptible
commands; no timing or speedup claim is made. One physical command still cannot be
interrupted, and 16 workgroups is a tested setting only once the hardware gate
passes, not a universal driver guarantee.

The logical seed batch remains 10,000. Merely shrinking it would change the old
random-stream mapping: the shader ignores its existing `rng_offset` field and
uses batch-local workgroup/seed/lane indices. The new, appended workgroup-offset
field restores those original indices inside each physical command for both seed
lookups and Philox initialization. It does not reinterpret `rng_offset`, alter
tracking steps/attempts, reduce the number of selected seeds, or change the output
order. Source pin provenance and original file hashes are recorded in the vendor
README and manifest. The same source pin also fixes TRX ZIP timestamps so equal
scientific outputs have equal archives; uncompressed member data is unchanged.

Node tests verify complete ordered workgroup coverage, parameter-buffer lifetime,
partition-invariant lane IDs, failure propagation and queued cancellation,
including cancellation at the final window. A hardware probe loads the actual
Boot parameter struct, workgroup/index/Philox expressions, RNG implementation and
host dispatcher to compare random streams across window sizes 37, 16, 7 and 1.
The real-data regression additionally requires all tracking commands to respect
the 16-workgroup bound while retaining the logical 10,000-seed batch.

The patch still awaits a successful rerun of these Metal tests; no source or unit
test result alone establishes that the device-loss issue is fixed. Intel/Mesa
validation remains separate. Source review also identified a fixed 32-lane
subgroup assumption and removed subgroup barriers. WGSL does not guarantee that
width or the mapping from local invocation IDs to subgroup lane IDs
([WGSL §15.5](https://www.w3.org/TR/WGSL/#subgroups)); the bounded-command change
does not claim to resolve those portability questions.
