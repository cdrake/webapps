---
"pipeline-builder": patch
---

Changing a step's binding now drops a workflow input once no step reads it, so an exported workflow never declares an input that `neuroflow-mcp` would require and nothing uses. When the tool catalog cannot load, the automation `validate` operation fails with the load error and the drop zone accepts no workflow. Exported workflows need NeuroFlow 0.2.0 or later.
