---
"@neurodesk/desktop": minor
"@neurodesk/webapp-components": minor
---

The desktop MCP server also offers NiiVue's own agent tools (`@niivue/nv-mcp`): each retained NiiVue viewer is a tab, so `list_tabs`, `where_am_i`, `go_to_point`, `set_view`, `screenshot` and the rest act on it through its session. Viewers register a `niivue` capability and answer the new `viewers.niivue` command. Loading tools can also load a local file or another URL once a person approves it in a dialog, or when it is listed in `NEURODESK_APPROVED_SOURCES`; `NEURODESK_SOURCE_APPROVAL=deny` refuses without asking. The new `sessions_grant` tool approves a source ahead of time, and each approval or refusal is recorded under `sources` in the run record.
