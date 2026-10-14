// Scheduling only: immutable input order, bounded live work, no refill after failure.
export async function* settledMigrationBatches(items, concurrency, action) {
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    const results = await Promise.allSettled(batch.map(async (item, index) => action(item, offset + index)));
    const settled = batch.map((item, index) => ({ item, position: offset + index, result: results[index] }));
    yield settled;
    throwMigrationBatchFailures(settled);
  }
}

export function migrationBatchFailures(batch) {
  return batch.flatMap(({ item, position, result }) => {
    if (result.status !== 'rejected') return [];
    const key = item?.key || item?.unit_id || item?.intent?.key || item?.manifest_key || (Array.isArray(item) ? item[0] : null);
    const error = new Error(`Migration input ${position}${key ? ` (${key})` : ''}: ${result.reason?.message || String(result.reason)}`, { cause: result.reason });
    error.position = position;
    if (key) error.key = key;
    return [error];
  });
}

export function migrationFailure(errors) {
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, `${errors[0]?.message || String(errors[0])} (${errors.length} failures)`, { cause: errors[0] });
}

export async function withMigrationBatchEvidence(batch, action, failurePosition = null) {
  try { return await action(); } catch (error) {
    const wrapped = new Error(error?.message || String(error), { cause: error });
    if (failurePosition) wrapped.position = failurePosition();
    throwMigrationBatchFailures(batch, wrapped);
  }
}

export function throwMigrationBatchFailures(batch, additionalError = null) {
  const failures = migrationBatchFailures(batch);
  if (additionalError) failures.push(additionalError);
  failures.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  if (failures.length) throw migrationFailure(failures);
}

// JSON reports cannot preserve native Error.errors/cause without explicit
// serialization. Keep all siblings, recursively and in immutable input order.
export function migrationFailureEvidence(error) {
  return {
    name: error?.name || 'Error', message: error?.message || String(error),
    ...(error?.position !== undefined ? { position: error.position } : {}),
    ...(error?.key ? { key: error.key } : {}),
    ...(error?.blockers ? { blockers: [...error.blockers] } : {}),
    ...(Array.isArray(error?.errors) ? { errors: error.errors.map(migrationFailureEvidence) }
      : error?.cause ? { cause: migrationFailureEvidence(error.cause) } : {}),
  };
}

export function exactPublicationEvidence(result, expected, flag) {
  return result?.verified === true && result?.[flag] === true &&
    result.key === expected.key && result.byte_size === expected.byte_size &&
    result.sha256 === expected.sha256;
}
