/**
 * The built-in fixed images an app offers, from registry/templates.json.
 * The app imports the catalogue and passes it here; the package never reads
 * the registry itself. An app that is not a consumer offers no templates.
 */
export function templatesFor(catalogue, appId) {
  const consumer = catalogue?.consumers?.[appId];
  if (!consumer) return [];
  return (catalogue.templates || []).filter(entry => {
    if (consumer.ids && !consumer.ids.includes(entry.id)) return false;
    if (consumer.dimensionality && entry.dimensionality !== consumer.dimensionality) return false;
    return true;
  });
}

/** The fetchModel asset for a catalogue entry: checksummed, cached by URL. */
export function templateAsset(entry) {
  return {
    url: entry.url,
    cacheKey: entry.url,
    integrity: { sha256: entry.sha256, bytes: entry.bytes },
  };
}
