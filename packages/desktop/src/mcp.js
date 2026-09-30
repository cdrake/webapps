import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { requestSchema } from './contracts.js';

const app = z.string().regex(/^[a-z][a-z0-9-]*$/);
const run = z.strictObject({ runId: z.string().min(1) });
const request = z.strictObject({
  app,
  operation: app.optional(),
  inputs: z.record(z.string().min(1), z.union([
    z.array(z.string().min(1)).min(1), z.strictObject({ url: z.httpUrl() }), z.strictObject({ directory: z.string().min(1) }),
  ])).optional(),
  parameters: z.record(z.string(), z.json()).optional(),
  selections: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  engine: z.enum(['browser', 'native']).optional(),
  timeoutMs: z.number().int().min(1).max(86400000).optional(),
  retainViewer: z.boolean().optional(),
});
const session = z.strictObject({ sessionId: z.string().min(1) });
const viewer = session.extend({ viewerId: app });
const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const startsRun = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function registerTool(server, name, description, inputSchema, annotations, handler) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Tool name is not portable across clients: ${name}`);
  server.registerTool(name, { description, inputSchema, annotations }, async args => {
    try {
      return result(await handler(args));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(error?.message ?? error) }],
      };
    }
  });
}

export async function createMcpServer(service, { version }) {
  const server = new McpServer({ name: 'neurodesk-webapps', version });
  registerTool(server, 'apps_list', 'List installed applications and their automation contracts.',
    z.strictObject({}), readOnly, async () => ({ apps: await service.listApps() }));
  registerTool(server, 'apps_describe', 'Read an installed application automation contract.',
    z.strictObject({ app }), readOnly, ({ app }) => service.describeApp(app));
  registerTool(server, 'apps_validate', 'Validate local input paths and parameters without starting processing.',
    request, readOnly, ({ app, ...request }) => service.validate(app, request));
  registerTool(server, 'runs_start', 'Start processing and return a run ID immediately. Use runs_get to observe completion.',
    request, startsRun, ({ app, ...request }) => service.start(app, request));
  registerTool(server, 'runs_get', 'Read a run state, report URI and any processing error.',
    run, readOnly, ({ runId }) => service.get(runId));
  registerTool(server, 'runs_cancel', 'Cancel a run and release its processing resources. Completed runs stay terminal.',
    run, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    ({ runId }) => service.cancel(runId));

  registerTool(server, 'sessions_list', 'List retained application viewers. Closing a session preserves its completed run report.',
    z.strictObject({}), readOnly, async () => ({ sessions: await service.listSessions() }));
  registerTool(server, 'sessions_close', 'Close a retained viewer and release its memory.',
    session, { ...startsRun, idempotentHint: true }, ({ sessionId }) => service.closeSession(sessionId));
  for (const [name, description, schema, mutates] of [
    ['list', 'List the actual viewers and supported controls in a retained session.', session, false],
    ['state', 'Read the current crosshair, tabs and image location.', viewer, false],
    ['crosshair', 'Move the crosshair using three world coordinates in millimetres. Returns the actual snapped viewer position.', viewer.extend({
      position: z.strictObject({ frame: z.literal('mm'), value: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]) }),
    }), true],
    ['tab', 'Select an application tab by its reported ID.', viewer.extend({ tabId: z.string().min(1) }), true],
    ['regions', 'Read the regions exposed by the application viewer.', viewer, false],
  ]) {
    registerTool(server, `viewers_${name}`, description, schema, mutates ? { ...startsRun, idempotentHint: true } : readOnly,
      async ({ sessionId, ...args }) => {
        const value = await service.viewerCommand(sessionId, `viewers.${name}`, args);
        return name === 'list' ? { viewers: value } : name === 'regions' ? { regions: value } : value;
      });
  }

  for (const contract of await service.listApps()) {
    registerTool(server, `run_${contract.app.replaceAll('-', '_')}`,
      `Start ${contract.title}. ${contract.description} Returns a run ID; use runs_get for completion.`,
      requestSchema(contract), startsRun, request => service.start(contract.app, request));
    if (contract.schemaVersion === 2) {
      for (const [name, operation] of Object.entries(contract.operations)) {
        if (name === contract.defaultOperation) continue;
        registerTool(server, `run_${contract.app.replaceAll('-', '_')}__${name.replaceAll('-', '_')}`,
          `Start ${operation.title}. ${operation.description} Returns a run ID; use runs_get for completion.`,
          requestSchema(contract, name), startsRun, request => service.start(contract.app, request));
      }
    }
  }

  for (const resource of [
    { name: 'run-report', template: 'neurodesk://runs/{runId}/report', pattern: /^neurodesk:\/\/runs\/[^/]+\/report$/, mimeType: 'application/json' },
    { name: 'run-artifact', template: 'neurodesk://runs/{runId}/artifacts/{artifactId}', pattern: /^neurodesk:\/\/runs\/[^/]+\/artifacts\/[^/]+$/ },
  ]) {
    server.registerResource(resource.name, new ResourceTemplate(resource.template, {
      list: async () => ({ resources: (await service.listResources()).filter(entry => resource.pattern.test(entry.uri)) }),
    }), resource.mimeType ? { mimeType: resource.mimeType } : {},
    async uri => ({ contents: await service.readResource(uri.href) }));
  }
  return server;
}

export function serveMcp(service, options) {
  const transport = new StdioServerTransport();
  const handle = serveStdio(() => createMcpServer(service, options), {
    transport,
    onerror: error => console.error(`MCP: ${error.message}`),
  });
  let closing;
  const closeService = () => closing ??= Promise.resolve().then(() => service.close());
  const onclose = transport.onclose;
  transport.onclose = () => {
    onclose();
    void closeService().catch(error => console.error(`MCP shutdown: ${error.message}`));
  };
  return {
    async close() {
      try {
        await handle.close();
      } finally {
        await closeService();
      }
    },
  };
}
