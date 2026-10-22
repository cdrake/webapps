// The vendored NeuroFlow core (vendor/neuroflow), the validator neuroflow-mcp runs.
import init, { validate_workflow_with_tools_json } from "../vendor/neuroflow/neuroflow.js";

let ready = null;

/**
 * Validates a workflow against the tools it uses. Resolves to
 * `{ ok, issues: [{ severity, message, path, outcome? }] }`. `module` is the
 * WASM source for init (a URL, bytes or module); omitted, it loads the vendored file.
 */
export async function validateWorkflow(workflow, tools, module) {
  ready ??= init(module === undefined ? undefined : { module_or_path: module });
  await ready;
  return JSON.parse(validate_workflow_with_tools_json(JSON.stringify(workflow), JSON.stringify(tools)));
}
