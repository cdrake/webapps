import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { originAllowed, startAgentServer } from '../src/server.js';

let server;
const lines = [];

before(async () => {
  server = startAgentServer({ port: 0, log: line => lines.push(line) });
  await server.listening;
});
after(() => server.close());

/** Opens the app socket as a page on `origin` would; resolves with the socket, or rejects with the refusal's status. */
function openPage(origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(server.appUrl, { origin });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

function get(path, host) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.port, path, headers: { host } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

test('pages on the hosted site and on loopback may connect; others may not', async () => {
  assert.equal(originAllowed(undefined, '127.0.0.1', []), true);
  assert.equal(originAllowed('http://localhost:5173', '127.0.0.1', []), true);
  assert.equal(originAllowed('https://evil.example', '127.0.0.1', []), false);
  assert.equal(originAllowed('not a url', '127.0.0.1', []), false);

  (await openPage('https://webapps.neurodesk.org')).close();
  await assert.rejects(openPage('https://evil.example'), { status: 403 });
  assert.ok(lines.includes('refused a socket from https://evil.example'));
});

test('an agent reaches a connected page through /mcp', async () => {
  const page = await openPage('https://webapps.neurodesk.org');
  page.on('message', data => {
    const { id, method, params } = JSON.parse(data.toString());
    if (method === 'set_view') page.send(JSON.stringify({ id, result: { slice: params.slice } }));
  });
  page.send(JSON.stringify({ hello: { id: 'brain', title: 'Brain Extraction', url: 'https://webapps.neurodesk.org/brain-extraction/', state: null } }));

  const agent = new Client({ name: 'test', version: '0.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  try {
    const { tools } = await agent.listTools();
    assert.ok(tools.some(tool => tool.name === 'set_view'));
    const listing = await agent.callTool({ name: 'list_tabs', arguments: {} });
    assert.match(JSON.stringify(listing.content), /Brain Extraction/);
    const view = await agent.callTool({ name: 'set_view', arguments: { slice: 'axial' } });
    assert.notEqual(view.isError, true, JSON.stringify(view.content));
  } finally {
    await agent.close();
    page.close();
  }
  assert.ok(lines.some(line => line.startsWith('tab connected: brain')));
});

test('the status page and /mcp answer only to this server’s own host names', async () => {
  const own = await get('/', `127.0.0.1:${server.port}`);
  assert.equal(own.status, 200);
  assert.match(own.body, /mcp endpoint: http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.equal((await get('/', 'rebound.example')).status, 403);
  assert.equal((await get('/mcp', 'rebound.example')).status, 403);
});

/** Writes `text` to the server as it is and resolves with the status line it answers. */
function raw(text) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, '127.0.0.1', () => socket.write(text));
    socket.once('data', data => {
      resolve(data.toString().split('\r\n')[0]);
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

test('a malformed request or frame is refused without stopping the server', { timeout: 5000 }, async () => {
  const host = `127.0.0.1:${server.port}`;
  assert.equal(await raw(`GET http://[ HTTP/1.1\r\nHost: ${host}\r\n\r\n`), 'HTTP/1.1 404 Not Found');
  const upgrade = 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n';
  assert.equal(await raw(`GET http://[ HTTP/1.1\r\nHost: ${host}\r\n${upgrade}\r\n`), 'HTTP/1.1 404 Not Found');
  const page = await openPage('https://webapps.neurodesk.org');
  const closed = new Promise(resolve => page.once('close', resolve));
  page.send(Buffer.from([0xff, 0xfe]), { binary: false });
  assert.equal(await closed, 1007, 'a text frame that is not UTF-8 closes that socket');
  assert.equal((await get('/', host)).status, 200);
});
