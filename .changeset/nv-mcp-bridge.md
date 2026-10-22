---
"@neurodesk/desktop": minor
"@neurodesk/webapp-components": minor
---

The desktop MCP server also offers NiiVue's own agent tools (`@niivue/nv-mcp`): each retained NiiVue viewer is a tab, so `list_tabs`, `where_am_i`, `go_to_point`, `set_view`, `screenshot` and the rest act on it through its session. Viewers register a `niivue` capability and answer the new `viewers.niivue` command.
