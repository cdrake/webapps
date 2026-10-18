import type { TemplateCatalogue, TemplateEntry } from '../elements/image-pair.js';

export function templatesFor(catalogue: TemplateCatalogue, appId: string): TemplateEntry[];
export function templateAsset(entry: TemplateEntry): { url: string; cacheKey: string; integrity: { sha256: string; bytes: number } };
