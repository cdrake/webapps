/** Runs one niimath argv over in-memory files on one cached module of the vendored dtifit build. */
export function runNiimath(
  args: string[],
  files?: { inputs?: Record<string, Uint8Array>; outputs?: string[] },
): Promise<{ outputs: Record<string, Uint8Array<ArrayBuffer>> }>;
