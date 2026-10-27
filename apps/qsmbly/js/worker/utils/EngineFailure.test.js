/**
 * EngineFailure Tests
 */
import { describeFailure } from './EngineFailure.js';

describe('describeFailure', () => {
  test('reports an engine error as it is', () => {
    const error = Object.assign(new Error('no phase'), { kind: 'input' });
    expect(describeFailure(error)).toEqual({ message: 'no phase', kind: 'input', fatal: false });
  });

  test('names the panic behind a trap, not the trap', () => {
    const mod = { take_panic_wasm: () => 'index out of bounds (at lib.rs:3)' };
    const failure = describeFailure(new WebAssembly.RuntimeError('unreachable'), { mod });
    expect(failure).toEqual({ message: 'The engine panicked: index out of bounds (at lib.rs:3)', kind: 'panic', fatal: true });
  });

  test('falls back to the trap when the module kept no panic', () => {
    const failure = describeFailure(new WebAssembly.RuntimeError('unreachable'), { mod: { take_panic_wasm: () => undefined } });
    expect(failure).toEqual({ message: 'The engine stopped (unreachable)', kind: 'abort', fatal: true });
  });
});
