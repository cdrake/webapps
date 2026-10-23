// The messages a Patch2Self worker handles, without the worker itself, so that Node tests can
// run the page's schedule (pool.js) against the same code.
// In: { id, type: "gram" | "apply", data, count, groups, coefficients? },
//     { type: "grams", grams, groups } (kept for the solves that follow), { id, type: "solve", g, j }.
// Out: { id, grams } for "gram", { id, row } or { id, failed } for "solve", { id, data, max }
//      for "apply" (max: the largest finite value of the chunk), or { id, error }; "grams" has
//      no reply.

/** @returns (message) => [reply, transfer] | null */
export function createWorkerTasks(p2s) {
  let summed = null;

  function solve(message) {
    try {
      const row = p2s.solveVolume(summed.grams[message.g], summed.groups[message.g], message.j);
      return [{ id: message.id, row }, [row.buffer]];
    } catch (error) {
      // The page reports the first failing volume in group order, so a failure is a result.
      return [{ id: message.id, failed: error?.message ?? String(error) }, []];
    }
  }

  function chunk(message) {
    const buffer = p2s.allocate(message.data.length);
    try {
      buffer.view().set(message.data);
      if (message.type === "gram") {
        const grams = message.groups.map((group) =>
          p2s.accumulate(buffer, message.count, group, new Float64Array(p2s.gramLength(group.length))),
        );
        return [{ id: message.id, grams }, grams.map((gram) => gram.buffer)];
      }
      message.groups.forEach((group, g) => p2s.apply(buffer, message.count, group, message.coefficients[g]));
      const out = buffer.view().slice();
      let max = -Infinity;
      for (let i = 0; i < out.length; i++) if (out[i] > max && Number.isFinite(out[i])) max = out[i];
      return [{ id: message.id, data: out, max }, [out.buffer]];
    } finally {
      buffer.free();
    }
  }

  return (message) => {
    try {
      if (message.type === "grams") {
        summed = { grams: message.grams, groups: message.groups };
        return null;
      }
      return message.type === "solve" ? solve(message) : chunk(message);
    } catch (error) {
      return [{ id: message.id, error: error?.message ?? String(error) }, []];
    }
  };
}
