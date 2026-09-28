const clone = value => structuredClone(value);

export function createNiivueAdapter(nv, { tabs, regions } = {}) {
  let location = null;
  const context = nv.createExtensionContext?.();
  context?.on('locationChange', event => {
    const detail = event.detail;
    location = { mm: Array.from(detail.mm ?? []), values: clone(detail.values ?? []) };
  });
  const crosshair = typeof nv.getCrosshairPos === 'function' && typeof nv.setCrosshairPos === 'function';
  return {
    state: () => ({
      position: crosshair ? { frame: 'fraction', value: Array.from(nv.getCrosshairPos()) } : null,
      location: clone(location),
      ...(tabs && { tabs: clone(tabs.list()) }),
    }),
    ...(crosshair && { setCrosshair: ({ frame, value }) => {
      if (frame !== 'fraction' || !Array.isArray(value) || value.length !== 3 || !value.every(number => Number.isFinite(number) && number >= 0 && number <= 1)) {
        throw new Error('Crosshair position requires three fractions between 0 and 1.');
      }
      nv.setCrosshairPos([...value]);
    } }),
    ...(tabs && { tabs }),
    ...(regions && { regions }),
  };
}

export function createViewerRegistry() {
  const viewers = new Map();
  function get(id) {
    if (!viewers.has(id)) throw new Error(`Unknown viewer: ${id}`);
    return viewers.get(id);
  }
  return {
    register(id, adapter) {
      if (!/^[a-z][a-z0-9-]*$/.test(id) || !adapter || typeof adapter.state !== 'function') throw new Error('A viewer needs a valid ID and a state function.');
      if (viewers.has(id)) throw new Error(`Viewer already registered: ${id}`);
      viewers.set(id, adapter);
      return () => viewers.delete(id);
    },
    list() {
      return [...viewers].map(([id, adapter]) => ({ id, capabilities: {
        state: true, crosshair: typeof adapter.setCrosshair === 'function', tabs: Boolean(adapter.tabs), regions: Boolean(adapter.regions),
      } }));
    },
    async dispatch(command, request) {
      if (command === 'viewers.list') return this.list();
      const adapter = get(request.viewerId);
      if (command === 'viewers.state') return clone(await adapter.state());
      if (command === 'viewers.crosshair') {
        if (!adapter.setCrosshair) throw new Error('This viewer does not support crosshair control.');
        await adapter.setCrosshair(request.position);
        return clone(await adapter.state());
      }
      if (command === 'viewers.tab') {
        if (!adapter.tabs) throw new Error('This viewer does not expose tabs.');
        if (!adapter.tabs.list().some(tab => tab.id === request.tabId)) throw new Error(`Unknown viewer tab: ${request.tabId}`);
        await adapter.tabs.select(request.tabId);
        return clone(await adapter.state());
      }
      if (command === 'viewers.regions') {
        if (!adapter.regions) throw new Error('This viewer does not expose regions.');
        return clone(await adapter.regions.list());
      }
      throw new Error(`Unknown viewer command: ${command}`);
    },
  };
}
