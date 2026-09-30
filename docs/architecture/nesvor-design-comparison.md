# NeSVoR architecture comparison

Two independent design sketches compared remote deployment using the same scientific runtime and repository constraints. A separate reviewer scored both and reviewed the combined design. The user subsequently required browser-native reconstruction in the same port. The remote comparison below remains relevant to that optional execution mode; it no longer defines the whole application. All scores are design judgments, not measured runtime results.

| Criterion, 1–5 | A: hosted frontend connects directly | B: backend serves the primary frontend |
| --- | --- | --- |
| In-app IP entry with separate compute | 5 | 3 |
| Shared UI and offline ownership | 4 | 5 |
| Scientific fidelity | 4 | 4 |
| Authentication, ownership and job lifecycle | 4 | 4 |
| Small interfaces and release verification | 4 | 4 |

Candidate A keeps imported stacks and viewer state in the current tab, connects to a paired HTTPS server, and hides transfers and job recovery behind a small client interface. Its main cost is institution-specific TLS, CORS and browser local-network permission setup.

Candidate B opens the same frontend from the backend before importing data. This removes cross-origin API requests, includes matching frontend assets, and supports isolated networks. It still requires trusted LAN HTTPS. Making navigation mandatory would interrupt the requested in-app server selection workflow and couple normal frontend updates to backend deployment.

Use A as the remote-mode base. Include B's bundled frontend as a first-release deployment option and its reuse of offline asset inventories. Declare browser execution plus optional remote execution in the desktop suite. Both candidates independently chose durable server jobs, per-owner authorization, one supervisor and bounded polling. Retain those shared remote decisions.

The final module map puts the Python service under proposed `services/compute-server`, correcting both sketches' use of `exes/`, which the repository reserves for native Rust executables. Keep NeSVoR science outside the transport package. The public methods hide wire schemas, offsets, authentication headers and polling, so app code does not become a second job controller. No generic command execution, arbitrary plugin system or workflow language is needed.

Rejected alternatives:

- A remote-only release does not satisfy the revised scope. Browser registration and fitting are required, with their own numerical gates; the CPU fallback source alone is not a browser implementation.
- A public relay would add an external data-handling and availability dependency to the clinician's network workflow.
- A separate desktop relay product would require another install and trust relationship. Extend the existing desktop host only for the selected server.
- An HTTP IP address with permissive CORS would not provide transport encryption, certificate identity or consistent browser compatibility.

The review found gaps in job listing after tab loss, receipt timing during uploads, retention wording and deletion semantics. The [final design](nesvor-webapp-design.md) incorporates these corrections. It distinguishes confirmed Linux/NVIDIA scope from untested hardware and browser compatibility, and specifies initial scientific stages separately from optional methods.

Verification in this phase consists of reading source and repository contracts, independent design comparison, local document-link checks and diff checks. No server, browser connectivity experiment or reconstruction was executed. The implementation gates remain in the final design.

## Browser engine comparison

The revised design compares an explicit NeSVoR forward/backward engine in WGSL with a general browser tensor/autodiff runtime. Both must implement the same full selected preset, including local SVoRT and registration selection.

| Criterion | Explicit scientific engine | General tensor/autodiff runtime |
| --- | --- | --- |
| Scientific control | Directly controls each derivative, reduction and optimizer group | Depends on operator and custom-gradient coverage |
| Memory control | Explicit buffer lifetimes and logical-batch tiling | Must prove allocation behavior for the full graph |
| Maintenance cost | Own numerical kernels and their tests | Reuse covered operations, but unsupported operations may require another execution path |
| Existing evidence | Repository has GPU inference and numerical WASM precedents, but no NeSVoR training engine | ORT has browser training examples, but no verified NeSVoR WebGPU training path was found |

Select the explicit engine as the proposed base. Use validated exported frozen-network subgraphs for SVoRT where they reduce maintained code. Keep a general training runtime as an alternative only if it proves the full representative step with less code and acceptable memory. This is an architectural choice pending numerical experiments, not a measured performance ranking.

The shared scientific contract has distinct browser and remote run identities. Browser runs do not inherit server persistence, and unsupported browser hardware never causes an upload. Full local reconstruction and the remote backend are both release requirements.
