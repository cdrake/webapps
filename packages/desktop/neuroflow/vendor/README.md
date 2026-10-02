# NeuroFlow schema snapshot

These unmodified NeuroFlow 0.1 schemas come from
[cdrake/neuroflow-spec at d8a87377660495f8f17f8c4f76a00295d8d91f1a](https://github.com/cdrake/neuroflow-spec/tree/d8a87377660495f8f17f8c4f76a00295d8d91f1a/schemas/0.1).
They are used under the included MIT license. Generation and tests validate
against this local snapshot without fetching a schema at runtime.

The launcher follows the script session contract implemented by
[cdrake/neuroflow at a47266dbe80357cfffaee1906179d81411765de6](https://github.com/cdrake/neuroflow/tree/a47266dbe80357cfffaee1906179d81411765de6).
It uses `core:result-file` and `neuroflow/launch`, and writes absolute artifact
paths to `result.json`. The upstream MCP runtime resolves the launch script
relative to the tool document and requires it to remain inside the registry.

To update this snapshot, copy `common.schema.json`, `events.schema.json`, and
`tool.schema.json`, and `extensions/neuroflow-mcp.schema.json` together, update the commit above and `snapshot.json`, and
run the generator tests. Do not edit the vendored schemas to admit generated
fields. Portable additions belong in an upstream RFC.
