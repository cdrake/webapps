# RFC draft: NiiVue MCP for desktop and hosted web apps

Status: Draft

Date: 2026-10-22

Implementation evidence: the desktop proof of concept on branch
`feat/nv-mcp-bridge`, described under [Proof of concept](#proof-of-concept).

## Summary

Adopt [`@niivue/nv-mcp`](https://github.com/niivue/mono/tree/main/packages/nv-mcp)
as the agent vocabulary for NiiVue viewers in Neurodesk Webapps. The desktop MCP
server registers nv-mcp's core tools beside its own `apps_*`, `runs_*` and
`sessions_*` tools, and routes them to retained viewer windows through an
Electron bridge. Hosted web apps later reach the same tools through nv-mcp's
WebSocket client and a server the user runs locally.

No image data leaves the user's machine in either path. A hosted relay is
described as a later option and is not proposed for implementation here.

## Motivation

[PR #529](https://github.com/neurodesk/webapps/pull/529) added
`viewers_volumes`, `viewers_display` and `viewers_screenshot` to the desktop
MCP server. Those tools exist only in the desktop, over stdio. The web apps at
webapps.neurodesk.org have no agent path.

NiiVue upstream now publishes nv-mcp. It does the same job for any NiiVue page:
an agent connects over streamable HTTP, the page keeps a WebSocket open to the
same server, and each tool call is answered by the page from its live scene. Its
tool set is a superset of ours. Maintaining a second NiiVue vocabulary would
duplicate upstream work and give agents two names for one action.

## Existing boundary

The two protocols overlap on viewer control and are disjoint elsewhere.

| Desktop tool | nv-mcp tool |
| --- | --- |
| `viewers_state` | `where_am_i` |
| `viewers_crosshair` | `go_to_point` |
| `viewers_volumes` | `where_am_i`, `describe_volume` |
| `viewers_display` | `set_view`, `set_volume` |
| `viewers_screenshot` | `screenshot` |
| `viewers_regions` | `list_regions`, `go_to_region` through the page's `atlas` hook |
| `sessions_list` | `list_tabs`, `use_tab` |

nv-mcp has no equivalent for application runs: `apps_*`, `runs_*`, `run_<app>`,
DICOM series selection, provenance and the report and artifact resources. It has
no equivalent for `viewers_tab`, which selects an application's own UI tab.
These remain Neurodesk tools.

nv-mcp has roughly 40 tools we lack, including clip planes, camera, meshes,
drawing, measurements and agent-placed controls.

## Compatibility evidence

`@niivue/nv-mcp@1.0.0-rc.7` was installed from npm and its server half was
driven from Node 24 against `@modelcontextprotocol/server@2.1.0`, the version
the desktop uses:

- `registerCoreTools(server, toolContext(bridge))` registered 62 tools on a
  2.1 `McpServer`, all with object input schemas.
- A 2.1 client called `where_am_i` and `screenshot` through nv-mcp's `Bridge`
  to a simulated page. `screenshot` returned an MCP image block, the same
  shape as `viewers_screenshot`.
- The 2.1 server rejected an unknown argument to `go_to_point` because nv-mcp
  declares strict object schemas.
- `@niivue/nv-mcp/server` imports in Node. `Bun.serve` is referenced only
  inside `startServer`, which the desktop does not call.

nv-mcp's browser half is written against NiiVue's 1.0 API through a `View`
interface. Comparing that interface with the installed NiiVue typings, every
member absent from 1.0.0-rc.9, rc.11, rc.13, rc.14 and rc.26 is optional in
`View`. Eighteen catalog viewers use a 1.0 release candidate. `surfannotate`
uses 0.69 and keeps the existing adapter.

## Design

### Page

`createNiivueAdapter` gains a `niivue` member. On first use it imports
`@niivue/nv-mcp/browser` dynamically, so apps pay for the code only when an
agent calls it, and builds `coreHandlers({ view: nv })` once. The viewer
registry adds one command, `viewers.niivue`, with `{ viewerId, method,
params }`. It returns `{ result, state }`, where `state` is nv-mcp's
`sceneState`. A request without `method` returns only the state.

`viewers.list` reports a `niivue` capability. The command is added to the
three desktop allowlists.

### Desktop

A bridge module owns one nv-mcp `Bridge`. When a viewer session is retained it
attaches a socket for that session, reads the scene state and sends nv-mcp's
`hello` with the session ID as the tab ID. Each request the bridge sends is
forwarded as `viewers.niivue` through the existing session queue, so the
desktop's serialization, 30 second timeout and session limit still apply. The
reply is fed back with `bridge.receive`. Closing a session detaches its socket.

`screenshot` is not answered by the page. It is routed to the existing
`viewers.screenshot` path, which composites the window with `capturePage`,
because these apps do not preserve the WebGL drawing buffer.

The MCP server calls `registerCoreTools` next to its own tools. The
`viewers_*` tools stay unchanged in this phase.

### Hosted web apps

The same page handlers answer nv-mcp's `AgentClient` over a WebSocket. The
user starts nv-mcp's `startServer` locally with
`allowedOrigins: ['https://webapps.neurodesk.org']`, or a small
`neurodesk-mcp` command that wraps it, and registers
`http://127.0.0.1:4242/mcp` with their agent. The page connects only when the
user turns on a "Connect an agent" control, shows that it is connected, and
can disconnect.

### Loading new sources

Each viewer window can read only what its run was given. That means the URLs
in the run's inputs and anything under them, the files the main process read
for the page, and directories mounted for a directory input. Browser
permission prompts are always denied. So `load_volume`, `add_overlay` and
`load_mesh` fail for any other URL, and a local path never works.

The desktop adds an approval step, so a source can be granted while the
session is open:

1. **Request.** The bridge checks the URL or path of every loading call before
   forwarding it. If the source is already granted to the window, the call
   proceeds unchanged. Otherwise the bridge asks for it. A
   `sessions_grant { sessionId, url | path }` tool makes the same request
   ahead of time, for agents that want to batch approvals.
2. **Consent.** The desktop shows a dialog attached to that viewer window. It
   names the agent's request, the file or URL, and the session's app, and
   offers **Allow** and **Deny**. The person at the viewer approves, not the
   agent client. MCP elicitation is not used, because client support varies
   and the client may not be the person viewing the data. If there is no
   answer before the session's 30 second command limit, the request is
   denied, and the tool error says so.
3. **Grant.**
   - **URL:** the URL is appended to the window's source grants.
     `createSourceGrants().add` currently replaces a window's list, so it
     gains an append form.
   - **Local path:** the file is resolved with `realpath` and served on its
     own through a one-time token on the local server, as directory inputs
     are. The forwarded call's argument is rewritten to that URL.
4. **Lifetime.** A grant belongs to the session. It is revoked, and a local
   file unmounted, when the session closes for any reason. Grants are never
   shared between windows and are not remembered across sessions.

Denials and approvals are recorded in the session's run record, so a report
can show which sources an agent added after the run.

In the hosted web apps the page cannot read local paths at all. There, the
same request appears as an in-page prompt with a file picker, and the
selected `File` is loaded directly.

### Later options

A hosted relay on Cloudflare Workers with a Durable Object per pairing would
let cloud agents reach a tab. The relay would carry screenshots and region
readouts derived from patient data, so it needs a privacy decision before any
implementation. AWS Lambda and Google Cloud Functions do not hold long-lived
WebSockets without extra services and are not proposed.

Browser-registered tools, such as the WebMCP draft, would need no server. The
page handlers above can be registered there once browsers support it.

## Phases

1. Desktop proof of concept: nv-mcp core tools over retained sessions.
2. Approved source loading on the desktop: consent dialog, appended grants,
   and single-file mounts.
3. Hosted page client behind an opt-in control, with a documented local server.
4. Alias then deprecate the overlapping `viewers_*` tools.
5. Decide on a hosted relay separately.

## Open questions

- **Viewer identity.** nv-mcp addresses a tab. Some apps register more than
  one viewer per page. The proof of concept drives the `main` viewer, or the
  first NiiVue viewer. Upstream could accept a viewer argument instead.
- **Approval scope.** [Loading new sources](#loading-new-sources) asks once
  per file or URL. Decide whether **Allow** may also cover a directory or a
  URL prefix for the rest of the session, and whether an unattended run, such
  as a desktop job or CI, may pre-approve sources through a configuration
  setting. The proof of concept pre-approves through
  `NEURODESK_APPROVED_SOURCES` and can refuse instead of asking through
  `NEURODESK_SOURCE_APPROVAL=deny`. The **Allow** scope is still open.
- **Duplicate MCP SDK.** nv-mcp depends on `@modelcontextprotocol/sdk` 1.x.
  The desktop also installs it beside 2.1. Ask upstream to make it a peer
  dependency or move to 2.x.
- **Prerelease tags.** npm's `latest` tag is `1.0.0-rc.1` and the tested code
  is `next`, `1.0.0-rc.7`. Pin the exact version.
- **Local network access.** Browsers increasingly ask before a public page
  opens `ws://127.0.0.1`. Test Chrome, Firefox and Safari before phase 3.
- **Atlas regions.** Apps expose regions through `viewers_regions` today.
  Mapping them onto nv-mcp's `atlas` hook needs an adapter per app.

## Proof of concept

Phase 1 runs on branch `feat/nv-mcp-bridge` against `@niivue/nv-mcp`
`1.0.0-rc.7`.

- **Real viewer.** `scripts/desktop/automation-smoke.mjs` runs BET in
  brain-extraction (NiiVue `1.0.0-rc.26`) under Electron on macOS and retains
  the viewer. Then it uses only nv-mcp tools:
  - `list_tabs` lists the session as a bound tab titled `brain-extraction`,
    with the scene state.
  - `go_to_point` moves to `[-18, -40, 6]`, and `where_am_i` reports
    `[-18, -40, 6.000002]`.
  - `set_view { slice: "coronal" }` changes the view, and `screenshot`
    returns a 2240×1508 PNG that differs from the earlier axial capture.

  The existing `viewers_*` checks pass unchanged in the same run. Linux under
  xvfb was not run.
- **Tests.**
  - Desktop: an MCP stdio test drives `list_tabs`, `go_to_point` and
    `screenshot` through a fake session. It checks that strict schemas reject
    unknown arguments, that a page error returns a tool error, and that a
    closed session leaves `list_tabs`.
  - Components: a test drives `viewers.niivue` against a fake NiiVue: state
    only, `set_view`, an unknown method, invalid parameters, and a 0.x viewer.
- **Bundle cost.** Vite emits the browser handlers as a separate lazy chunk:
  100 KB, 31 KB gzipped. It is loaded only on the first `viewers.niivue`
  call, and the app's main chunk does not grow.
- **Dependencies.**
  - The exact pin needs a `minimumReleaseAgeExclude` entry, because rc.7 is
    one day old. This matches the existing `@niivue` prerelease entries.
  - About 50 packages enter the lockfile through nv-mcp's
    `@modelcontextprotocol/sdk` 1.x, including express, hono, cors and jose.
    Only the desktop ships them. Making the SDK a peer dependency upstream
    would remove them.
- **Source approval.** Phase 2 is in the same branch.
  - The bridge finds every `url` argument in a call. An absolute path, a
    `file:` URL or an http(s) URL outside the window's grants is approved
    first, then rewritten to the granted address. Relative URLs pass through.
  - Approval comes from `NEURODESK_APPROVED_SOURCES`, a comma-separated list
    of absolute directories and http(s) URL prefixes, or from an
    **Allow**/**Deny** dialog on the viewer window. The dialog waits 30 s and
    then denies. `NEURODESK_SOURCE_APPROVAL=deny` refuses at once instead of
    asking.
  - An approved URL is appended to the window's grants. An approved file is
    served alone through a token URL on the local server, which checks that
    its real path has not changed. Both end with the session.
  - The smoke pre-approves its runs directory and sets `deny`. `add_overlay`
    of the run's BET mask by path adds a volume. `add_overlay` of the input
    fixture by path fails with the deny error and adds nothing. An earlier
    run with the dialog loaded the fixture after a person clicked **Allow**.
    **Deny** and the timeout were not tried by hand.
  - Not built yet: the `sessions_grant` tool, and recording approvals and
    denials in the run record.
- **Timeouts.** The bridge timeout is 65 s: a 30 s approval wait plus the
  session's 30 s command limit. A stalled page is reported by the session,
  which also closes it, before nv-mcp's own timer fires.
- **Screenshot.** The desktop answers nv-mcp's `screenshot` with a window
  capture, so its size and format arguments are ignored. Honouring them means
  scaling the capture in the main process.
- **Session lifecycle.** The automation service now publishes `ready` and
  `closed` session events. The bridge attaches a tab only once a run has
  succeeded, and detaches it when the session closes for any reason: a
  `sessions_close` call, a command timeout, the window closing, or shutdown.
