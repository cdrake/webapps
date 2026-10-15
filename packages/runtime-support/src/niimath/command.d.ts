export interface NiimathCommand {
  /** Runs `args` (niimath argv without the program name) over the named inputs and resolves to the named output. */
  run(args: string[], files: { inputs: Record<string, Uint8Array>; output: string }): Promise<Uint8Array>;
  /** Terminates the worker; the next run starts a fresh one. */
  dispose(): void;
}

export declare function createNiimathCommand(): NiimathCommand;
