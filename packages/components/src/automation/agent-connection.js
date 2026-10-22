/** The port `neurodesk-mcp` listens on unless told otherwise. */
export const agentServerPort = 4242;

/**
 * Connects the page's NiiVue viewer to an nv-mcp server on this computer, such as `neurodesk-mcp`, so an agent can
 * drive it with nv-mcp's tools. Nothing connects until `connect()`, which a person starts from the page; the client
 * then keeps retrying until `disconnect()`, so the server may start before or after.
 */
export function createAgentConnection(findViewer, { port = agentServerPort, WebSocket, storage } = {}) {
  const watchers = new Set();
  let client;
  let pending;
  let generation = 0;
  const status = (connected = Boolean(client?.connected)) => ({ active: Boolean(client || pending), connected, id: client?.id ?? null });
  const report = connected => {
    const current = status(connected);
    for (const watcher of watchers) watcher(current);
  };
  return {
    port,
    get status() { return status(); },
    /** Calls `watcher` with `{ active, connected, id }` whenever the connection changes; returns a function that stops it. */
    watch(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    connect() {
      if (client) return Promise.resolve();
      if (pending) return pending;
      const viewer = findViewer();
      if (!viewer) return Promise.reject(new Error('Open an image first. There is no viewer for an agent yet.'));
      const current = ++generation;
      // Only the page's own WebSocket address: a hosted page has no proxy to try first.
      pending = Promise.all([import('@niivue/nv-mcp/browser'), viewer.nvMcp()]).then(([{ AgentClient }, { handlers, state }]) => {
        if (current !== generation) return;
        client = new AgentClient(handlers, {
          urls: [`ws://127.0.0.1:${port}/app`],
          state,
          onStatus: report,
          ...(WebSocket && { WebSocket }),
          ...(storage !== undefined && { storage }),
        });
        client.attach();
      }).finally(() => {
        if (current !== generation) return;
        pending = undefined;
        report();
      });
      report();
      return pending;
    },
    disconnect() {
      generation++;
      pending = undefined;
      client?.detach();
      client = undefined;
      report(false);
    },
  };
}

/** A toolbar row with a button that connects or disconnects the agent, and a line saying where it stands. */
export function createAgentControl(connection, { document: doc = globalThis.document } = {}) {
  // Automation modules also load under Node, so this builds its elements without the browser-only UI helpers.
  const button = Object.assign(doc.createElement('button'), { className: 'nd-btn nd-btn-sm', type: 'button' });
  const line = Object.assign(doc.createElement('span'), { className: 'nd-viewer-label' });
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  const row = Object.assign(doc.createElement('div'), { className: 'nd-viewer-toolbar nd-agent-control' });
  row.append(button, line);
  const show = ({ active, connected, id }, error) => {
    button.textContent = active ? 'Disconnect agent' : 'Connect an agent';
    button.setAttribute('aria-pressed', String(active));
    line.textContent = error ? error.message
      : connected ? `Agent server connected. This viewer is tab ${id}.`
        : active ? `Waiting for neurodesk-mcp on port ${connection.port}. In Chrome, allow local network access when asked. Safari cannot connect.`
          : 'Lets an AI agent on this computer view and control this viewer through neurodesk-mcp.';
  };
  connection.watch(current => show(current));
  button.addEventListener('click', () => {
    if (connection.status.active) connection.disconnect();
    else connection.connect().catch(error => show(connection.status, error));
  });
  show(connection.status);
  return row;
}
