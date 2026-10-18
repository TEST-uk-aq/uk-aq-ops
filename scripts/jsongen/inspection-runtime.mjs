// A small fixed worker pool. Results preserve input order; no task starts after
// cancellation. Every worker is drained before the caller may publish its result.
export async function inspectionMap(values, operation, { concurrency = 4, stopped = () => false } = {}) {
  const results = new Array(values.length); let next = 0;
  async function worker() {
    while (!stopped()) {
      const i = next++;
      if (i >= values.length) return;
      results[i] = await operation(values[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, worker);
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find(o => o.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}
