export function createSourceGrants() {
  const windows = new Map();
  const contains = (root, value) => {
    const url = new URL(value);
    return url.origin === root.origin && !url.username && !url.password
      && (url.pathname === root.pathname || url.pathname.startsWith(`${root.pathname.replace(/\/$/, '')}/`));
  };
  return {
    add(id, sources) {
      const roots = sources.map(source => {
        const url = new URL(source);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid remote input URL');
        return url;
      });
      windows.set(id, roots);
    },
    permits(id, url) { return (windows.get(id) ?? []).some(root => contains(root, url)); },
    permitsAny(url) { return [...windows.values()].some(roots => roots.some(root => contains(root, url))); },
    remove(id) { windows.delete(id); },
  };
}
