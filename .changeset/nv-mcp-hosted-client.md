---
"@neurodesk/agent-server": minor
"@neurodesk/webapp-components": minor
"brain-extraction": patch
---

Hosted apps can hand their NiiVue viewer to an AI agent on the same computer. `automation.agentConnection()` and `createAgentControl()` connect the page to a local nv-mcp server only after the person chooses **Connect an agent**. The new `neurodesk-mcp` command (`@neurodesk/agent-server`) is that server for Node, accepting pages from `https://webapps.neurodesk.org` and localhost. Brain Extraction shows the control as a preview when opened with `?agent` (or `?agent=<port>`). Chrome asks to allow local network access, Firefox connects directly, and Safari cannot connect.
