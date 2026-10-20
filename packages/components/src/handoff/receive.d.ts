import type { HandoffSource } from './index.js';

/** Opens files another app sent here through the page's classified inputs; the shell calls it. */
export function receiveHandoff(document?: Document): Promise<{ source: HandoffSource; files: File[] } | null>;
