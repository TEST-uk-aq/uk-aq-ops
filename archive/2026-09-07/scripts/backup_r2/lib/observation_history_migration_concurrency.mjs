// Scheduling only: immutable input order, bounded live work, no refill after failure.
export async function* settledMigrationBatches(items, concurrency, action) {
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    const results = await Promise.allSettled(batch.map((item, index) => action(item, offset + index)));
    yield batch.map((item, index) => ({ item, position: offset + index, result: results[index] }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

export function exactPublicationEvidence(result, expected, flag) {
  return result?.verified === true && result?.[flag] === true &&
    result.key === expected.key && result.byte_size === expected.byte_size &&
    result.sha256 === expected.sha256;
}
