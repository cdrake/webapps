# NeSVoR remote compute implementation

NeSVoR has two intended execution modes: browser reconstruction and an optional
Linux NVIDIA backend on the clinician's network. The browser port is part of this
project. It cannot execute the upstream CUDA implementation unchanged.

The full design and scientific requirements live in
[nesvor-webapp-design.md](nesvor-webapp-design.md) and
[nesvor-browser-design.md](nesvor-browser-design.md). The pinned upstream source,
container, models and browser runtime research are recorded in
[nesvor-research.md](nesvor-research.md) and
[nesvor-browser-research.md](nesvor-browser-research.md).

## Current implementation

The Rust backend runs the pinned NeSVoR 0.5.0 container. The shared connection
panel exchanges an installation pairing code for a separate client credential.
Every job is owned by that client. Jobs, receipts and retention state are durable;
other clients cannot fetch, cancel or delete them. Cancellation and deletion are
separate operations. See [remote-compute-protocol.md](remote-compute-protocol.md)
for the endpoint contract.

The app imports NIfTI and converts DICOM locally using the shared importer. It
locks inputs while a job runs and names output files from the submitted input
snapshot. Partial mask assignments fail validation. The backend receives only
an allowlisted reconstruction specification, never shell commands.

The simulator exercises connection, upload, progress and download behavior. Its
output is a labelled average of input voxels. Passing simulator tests does not
validate NeSVoR, the example data, CUDA availability or the browser algorithm.

## Deployment

The first supported downloadable target is Linux x86-64 with an NVIDIA GPU.
The archive must contain the server and built frontend under `www/nesvor/`.
Docker, the NVIDIA Container Toolkit and the digest-pinned scientific image are
separate dependencies. An archive containing only the server is not an offline
scientific runtime.

A site may open the bundled page on the backend's HTTPS origin or connect from
the hosted webapp. HTTPS certificates must be trusted by the clinician's browser.
Hosted HTTPS pages generally cannot call plain HTTP LAN servers. CORS permission
and browser local-network permission are separate checks; a CORS response alone
does not guarantee access. The same-origin bundled page avoids cross-origin
requests. A plain HTTP LAN page is not a secure context for browser GPU execution.

No relay carries patient data through Neurodesk. Downloads of public examples
and model assets are separate from patient transfers to the selected backend.

## Completion gates

See [nesvor-design-status.md](nesvor-design-status.md) for the actual verification
state. The release must include a real container example run and numerical
comparisons for the browser implementation. Published download metadata must
refer to an existing archive with a verified checksum. A prepared workflow or a
CI artifact does not mean a public download exists.
