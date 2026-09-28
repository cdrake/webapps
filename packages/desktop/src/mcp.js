import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { requestSchema } from './contracts.js';

const app = z.string().regex(/^[a-z][a-z0-9-]*$/);
const run = z.strictObject({ runId: z.string().min(1) });
const request = z.strictObject({
  app,
  inputs: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  engine: z.enum(['browser', 'native']).optional(),
  timeoutMs: z.number().int().min(1).max(86400000).optional(),
});
const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const startsRun = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function registerTool(server, name, description, inputSchema, annotations, handler) {
  server.registerTool(name, { description, inputSchema, annotations }, async args => {
    try {
      return result(await handler(args));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
      };
    }
  });
}

export async function createMcpServer(service, { version }) {
  const server = new McpServer({ name: 'neurodesk-webapps', version });
  registerTool(server, 'apps.list', 'List installed applications and their automation contracts.',
    z.strictObject({}), readOnly, async () => ({ apps: await service.listApps() }));
  registerTool(server, 'apps.describe', 'Read an installed application automation contract.',
    z.strictObject({ app }), readOnly, ({ app }) => service.describeApp(app));
  registerTool(server, 'apps.validate', 'Validate local input paths and parameters without starting processing.',
    request, readOnly, ({ app, ...request }) => service.validate(app, request));
  registerTool(server, 'runs.start', 'Start processing and return a run ID immediately. Use runs.get to observe completion.',
    request, startsRun, ({ app, ...request }) => service.start(app, request));
  registerTool(server, 'runs.get', 'Read a run state, report URI and any processing error.',
    run, readOnly, ({ runId }) => service.get(runId));
  registerTool(server, 'runs.cancel', 'Cancel a run and release its processing resources. Completed runs stay terminal.',
    run, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    ({ runId }) => service.cancel(runId));

  for (const contract of await service.listApps()) {
    registerTool(server, `run_${contract.app.replaceAll('-', '_')}`,
      `Start ${contract.title}. ${contract.description} Returns a run ID; use runs.get for completion.`,
      requestSchema(contract), startsRun, request => service.start(contract.app, request));
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
