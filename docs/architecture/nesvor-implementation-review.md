# NeSVoR implementation review

Reviewed `origin/t3code/design-nesvor-remote-backend` after fetching, at `94f7cac262de62a02d16b6a15197f91abcb70c5d`, against merge base `b0bb95ae586c2688d36b47e76d5dbcd31bb663cc`.

The branch implements a remote-compute application, but does not satisfy the explicit requirement for browser-native reconstruction. Its design notes describe an earlier, narrower scope. The remote implementation also has correctness and recovery issues that passing simulated-runner tests do not cover.

The comparison uses the user's browser-plus-remote requirement, the [current design](nesvor-webapp-design.md), the [browser design](nesvor-browser-design.md), and repository interface/offline contracts. Architectural differences alone are not defects. A Rust server under `exes/` is consistent with this repository; the Python service in our proposal was a design choice, not a requirement.

## Standards

### P1: A completed result can acquire another input's identity

[`apps/nesvor/src/main.js:411`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/apps/nesvor/src/main.js#L411) builds the output filename from live `rows[0]`. The Remove control at line 206 and input/example replacement remain available during reconstruction. Removing every stack makes a completed job fail before download. Replacing the stacks can name the previous examination's result after the replacement input. Capture immutable job input identity and reject or explicitly manage input replacement while processing. This violates the interface standard's prohibition on presenting old results under new input.

### P1: Disconnect does not clear the saved credential

[`compute-connection.js:168`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/packages/components/src/elements/compute-connection.js#L168) clears the client and info only. The token remains in the field and localStorage; restore reloads it at line 196. This contradicts the app's Privacy text at `apps/nesvor/index.html:152`, which promises persistence only until disconnect. On a shared workstation, the next user can reconnect with the previous credential. Clear credentials on disconnect and use the intended explicit credential-storage policy.

### P2: Scan imports do not support DICOM

[`apps/nesvor/src/main.js:288`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/apps/nesvor/src/main.js#L288) filters uploads to NIfTI names and rejects DICOM. The interface standard requires local conversion through shared helpers, including extensionless instances, with separate acquisitions preserved. An unrestricted file picker does not satisfy that contract.

### P2: The scientific example has no real execution gate

[`apps/nesvor/e2e/smoke.spec.js:107`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/apps/nesvor/e2e/smoke.spec.js#L107) explicitly verifies a simulated output. The branch's verification record correctly says no CUDA reconstruction was run, and the desktop workflow also uses the reference simulator. These tests establish UI/transport behavior, not that the chosen example reconstructs through NeSVoR. Keep them and add actual engine coverage before claiming the example/offline workflow complete.

## Spec

### P1: Required browser reconstruction is absent

[`apps/nesvor/src/main.js:260`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/apps/nesvor/src/main.js#L260) disables processing without `connection.client`; line 396 always submits remotely. There is no local registration, training or sampling implementation. The notes at `docs/architecture/nesvor-remote-compute.md:52` explicitly reject it. The user's instruction and our completion contract require both modes. Restore browser execution as a required delivery track rather than treating it as infeasible and out of scope.

### P1: Jobs have no per-clinician authorization

[`exes/compute-server/src/auth.rs:94`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/exes/compute-server/src/auth.rs#L94) authenticates every caller against one installation token. Job handlers accept an ID without owner identity. Anyone sharing that credential can retrieve or delete another clinician's known job ID. Random IDs do not implement the specified ownership boundary. Introduce scoped identities and check ownership on status, logs, outputs, cancellation and deletion.

### P1: Restart loses jobs and leaves files outside retention

[`exes/compute-server/src/jobs.rs:235`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/exes/compute-server/src/jobs.rs#L235) creates an empty in-memory store. Startup does not recover existing job directories. After a crash, their records disappear and the retention sweep only examines new in-memory jobs. Patient files can remain indefinitely while results become inaccessible. Graceful shutdown instead deletes all registered jobs at lines 405–412. Persist records, reconcile interrupted processes/files at startup, and separate service shutdown from deleting results. A focused reproduction confirmed that a newly initialized store cannot see an existing successful job and does not sweep its files even with zero retention.

### P1: A lost submission response can duplicate GPU work

[`exes/compute-server/src/api.rs:239`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/exes/compute-server/src/api.rs#L239) generates a fresh ID for every multipart POST. The job is queued before the only receipt reaches the browser. Losing that response leaves accepted work without a recoverable client reference; retry queues another job. There is no idempotency key or resumable upload. A focused reproduction sent identical submissions with the same idempotency header and received different accepted job IDs. Create the recoverable draft first and enforce owner-scoped submission identity.

### P2: Cancellation is declared complete before execution stops

[`exes/compute-server/src/jobs.rs:382`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/exes/compute-server/src/jobs.rs#L382) emits cancelled/done before signalling the runner. The app aborts observation and suppresses cancellation errors. It can therefore report cancellation while processing continues. Preserve a cancelling state and emit the terminal event only after the process exits; keep deletion distinct from cancellation.

### P2: Packaged downloads omit the promised frontend/runtime

[`compute-server-native.yml:61`](https://github.com/neurodesk/webapps/blob/94f7cac262de62a02d16b6a15197f91abcb70c5d/.github/workflows/compute-server-native.yml#L61) stages only the executable and documentation. It does not build or bundle the `www/` frontend promised in the implementation notes, nor an offline scientific runtime. The workflow uploads CI artifacts, and `registry/standalone.json` still has an empty NeSVoR downloads list. This is a server wrapper with external runtime prerequisites, not the proposed complete downloadable offline backend. Either complete the artifact and publication path or label the current distribution's narrower prerequisites and status precisely.

## Notes compared with the current design

| Topic | Branch implementation notes | Current design / review conclusion |
| --- | --- | --- |
| Shared workspace and server adapter | Uses shared controls and tool-specific argv construction | Consistent foundation |
| Server implementation language | Rust | Acceptable repository-aligned choice |
| Browser compute | Declares training infeasible and excludes it | Required; numerical feasibility must be measured, not dismissed without a prototype |
| Backend science | Pinned container; real CUDA run not performed | Good source pinning, scientific validation still outstanding |
| Authentication | One stored installation token | No per-clinician ownership; automatic localStorage persistence differs from proposed policy |
| Job lifetime | In-memory, cancel/delete combined, cleanup on shutdown | Durable records, interrupted recovery and distinct cancellation/deletion were intended |
| Scientific scope | Neonatal/body/deformable presets and optional segmentation/N4 | Broader than the proposed first fetal supplied-mask preset; each needs its own assets, citations and validation |
| Slice thickness | Prefills from spacing and permits immediate execution | Acquisition thickness needs explicit confirmation when unknown |
| Offline execution | Simulator exercises desktop workflow | Must prove actual browser engine and real backend independently |
| Server-hosted frontend | Promised in archive | Not staged by the workflow |

The browser-network section also needs correction. It conflates Local Network Access permission with the earlier Private Network Access preflight mechanism and treats hosted HTTPS-to-LAN HTTP blocking as universal. Chrome documents permission-gated exceptions and explicitly distinguishes LNA from PNA. That does not make unencrypted LAN HTTP the desired clinical transport. Keep trusted HTTPS as the supported baseline and test browser behavior. [Chrome's primary guidance](https://developer.chrome.com/blog/local-network-access).

The categorical statements that the method is inseparable from CUDA/data-centre GPUs and that a browser port will be tens of times slower are unsupported by the branch's measured evidence. The pinned source includes CPU fallbacks, and our [browser research](nesvor-browser-research.md) describes concrete training and registration operations to port. Neither fact proves browser performance; the appropriate conclusion is that it remains to be implemented and measured.

## Verification performed

The branch was extracted into an isolated directory under `TMPDIR`; no implementation files in the working branch were changed.

- `cargo test --locked --offline`: 26 unit tests and 8 integration tests passed.
- App unit tests plus desktop compute-origin tests: 11 passed.
- Shared compute-client tests: 5 passed.
- Two added scratch reproductions confirmed duplicate submissions and loss of retention ownership on store restart. The assertions deliberately test the current defects, not desired corrected behavior.

The initial JavaScript attempt lacked a workspace package link in the isolated archive. After linking its own components package, the focused tests passed. Rust/HTTP tests required loopback access and were rerun successfully with it. No full production build, screenshot audit, browser E2E or CUDA numerical run was performed in this review.

Standards: four findings, with incorrect result identity and retained credentials the highest severity. Spec: six findings, with the missing browser engine, missing job ownership and non-durable execution the highest severity.
