import { createHash } from 'node:crypto';
import { demand, same, sha256 } from './bounded_verify_store.mjs';
import { r2GetMigrationObjectBounded } from '../backup_r2/lib/observation_history_migration_bounded_r2.mjs';
import { r2HeadObject } from '../../workers/shared/r2_sigv4.mjs';
import { verifyR2StoredSha256Head } from '../../workers/shared/uk_aq_r2_checksum_publication.mjs';
import { readCanonicalObservationRowsFromParquetBytes } from '../backup_r2/lib/observation_history_migration_v3.mjs';
import {
  encodeCanonicalObservationRow, OBSERVATION_CONTENT_HASH_PREFIX, OBSERVATION_CONTENT_HASH_COLUMNS,
} from '../../workers/shared/uk_aq_observation_content_hash.mjs';

// The capability supplied to verification has only GET/HEAD. No mutation or
// migration adapter is constructed, and no publication API is invoked.
export function boundedR2Reads({ r2, store, maxObjectBytes }) {
  return Object.freeze({
    getObject: async ({ key, max_bytes = maxObjectBytes }) => {
      store.assertHeld();
      demand(Number.isSafeInteger(max_bytes) && max_bytes > 0 && max_bytes <= maxObjectBytes,
        `R2 object exceeds response buffer budget: ${key}`);
      const result = await r2GetMigrationObjectBounded({ r2, key, max_bytes });
      store.assertHeld(); return result;
    },
    headObject: async ({ key }) => {
      store.assertHeld(); const result = await r2HeadObject({ r2, key, accept_encoding_identity: true });
      store.assertHeld(); return result;
    },
  });
}

export async function verifyBoundedDependencies({ baseline, reads, concurrency }) {
  const { store } = baseline;
  store.phase = 'verify-current-r2-closure';
  // A cursor supplies at most concurrency descriptors, never an async work queue.
  let key = '';
  for (;;) {
    const batch = [...store.iterate('SELECT * FROM objects WHERE key>? ORDER BY key COLLATE BINARY LIMIT ?', key, concurrency)];
    if (!batch.length) break;
    const results = await Promise.allSettled(batch.map(async (entry) => {
      if (entry.stage === 'canonical_parquet' && entry.external === 1) {
        verifyR2StoredSha256Head({ head: await reads.headObject({ key: entry.key }),
          intent: { key: entry.key, byte_size: entry.size, sha256: entry.sha } });
      } else {
        const current = await reads.getObject({ key: entry.key, max_bytes: entry.size });
        demand(current.body.length === entry.size && sha256(current.body) === entry.sha,
          `Current R2 dependency identity differs: ${entry.key}`);
      }
    }));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') throw new Error(`Incomplete R2 verification: ${batch[index].key}`, { cause: result.reason });
      store.run('UPDATE objects SET verified=1 WHERE key=?', batch[index].key);
      store.counters.r2_dependencies++;
    }
    key = batch.at(-1).key;
    await store.boundary();
  }
  demand(!store.get('SELECT key FROM objects WHERE verified!=1 LIMIT 1'), 'R2 dependency scan incomplete');
}

const STABLE_BINDING_CACHE_LIMIT = 8192;

function createStableBindingCache(store) {
  const cache = new Map();
  return (timeseriesId) => {
    const cached = cache.get(timeseriesId);
    if (cached !== undefined) {
      // Map insertion order supplies a bounded LRU: the oldest entry is
      // evicted when a new authenticated binding arrives.
      cache.delete(timeseriesId); cache.set(timeseriesId, cached);
      return cached;
    }
    const binding = store.get('SELECT connector,pollutant FROM bindings WHERE id=?', timeseriesId);
    demand(binding && Number.isSafeInteger(binding.connector) && typeof binding.pollutant === 'string',
      `Stable binding is missing or malformed: ${timeseriesId}`);
    const verified = Object.freeze({ connector: binding.connector, pollutant: binding.pollutant });
    if (cache.size >= STABLE_BINDING_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(timeseriesId, verified);
    return verified;
  };
}

export async function verifyBoundedLogicalOutput({ baseline, reads, maxFileRows, maxUncompressedBytes }) {
  const { store, plan } = baseline;
  store.phase = 'verify-independent-logical-content';
  const stableBinding = createStableBindingCache(store);
  const logicalRowBatchSize = store.logicalRowBatchSize;
  for (let ordinal = 0; ordinal < baseline.unitCount; ordinal++) {
    const unit = baseline.unit(ordinal, false);
    const manifest = await reads.getObject({ key: unit.source_manifest_identity.key, max_bytes: unit.source_manifest_identity.byte_size });
    demand(manifest.body.length === unit.source_manifest_identity.byte_size && sha256(manifest.body) === unit.source_manifest_identity.sha256,
      `Locked source manifest changed: ${unit.unit_id}`);
    const metadata = async (files, target) => {
      store.run('DELETE FROM logical_rows');
      const statuses = { P: 0, R: 0, null: 0 }; let count = 0;
      for (const file of files) {
        const current = await reads.getObject({ key: file.key, max_bytes: file.byte_size });
        demand(current.body.length === file.byte_size && sha256(current.body) === file.sha256, `Independent Parquet identity differs: ${file.key}`);
        const rows = await readCanonicalObservationRowsFromParquetBytes({ body: current.body, connectorId: unit.scope.connector_id,
          sosConnectorId: plan.sos_connector_id, maxRows: maxFileRows,
          onMetadata: ({ uncompressedBytes }) => demand(uncompressedBytes <= maxUncompressedBytes,
            `Decoded Parquet byte budget exceeded: ${file.key}`) });
        let rowsSinceWriteBoundary = 0;
        for (const row of rows) {
          demand(row.connector_id === unit.scope.connector_id && row.pollutant_code === unit.scope.pollutant_code &&
            row.observed_at_utc.slice(0, 10) === unit.scope.day_utc, 'Decoded row contradicts planned partition');
          if (target) {
            const binding = stableBinding(row.timeseries_id);
            demand(binding && binding.connector === row.connector_id && binding.pollutant === row.pollutant_code,
              `Stable binding disagrees with target observation: ${row.timeseries_id}`);
          }
          const encoded = encodeCanonicalObservationRow(row);
          // The canonical v1 encoding is ASCII (integers, lower-case pollutant,
          // ISO UTC, float64 hex, P/R/null). SQLite BINARY exactly matches JS sort.
          demand(/^[\x20-\x7e]+$/.test(encoded), 'Unexpected non-ASCII v1 canonical row');
          store.run('INSERT INTO logical_rows VALUES(?)', encoded);
          statuses[row.verification_status === null ? 'null' : row.verification_status]++;
          count++;
          if (++rowsSinceWriteBoundary >= logicalRowBatchSize) {
            await store.logicalWriteBoundary();
            rowsSinceWriteBoundary = 0;
          }
        }
        // Commit the final partial file batch, and keep the existing
        // cooperative lock/resource checkpoint at every file boundary.
        await store.logicalWriteBoundary();
      }
      demand(count > 0, 'Independent partition has no observations');
      const hash = createHash('sha256'); hash.update(OBSERVATION_CONTENT_HASH_PREFIX);
      let rowsSinceReadBoundary = 0;
      for (const row of store.iterate('SELECT encoded FROM logical_rows ORDER BY encoded COLLATE BINARY')) {
        hash.update(row.encoded); hash.update('\n');
        if (++rowsSinceReadBoundary >= logicalRowBatchSize) {
          await store.logicalReadBoundary();
          rowsSinceReadBoundary = 0;
        }
      }
      await store.logicalReadBoundary();
      return { observation_content_hash: hash.digest('hex'), observation_content_hash_algorithm: 'sha256',
        observation_content_hash_contract_version: 1, observation_content_hash_row_count: count,
        observation_content_hash_columns: [...OBSERVATION_CONTENT_HASH_COLUMNS], verification_status_counts: statuses };
    };
    const source = await metadata(unit.source_files, false);
    const target = await metadata(unit.target_file_intents, true);
    demand(source.observation_content_hash_row_count === unit.source_row_count && same(source, target) &&
      same(target, unit.source_observation_content_hash_metadata), `Independent logical identity mismatch: ${unit.unit_id}`);
    store.counters.logical_partitions++; await store.boundary(true);
  }
  store.run('DELETE FROM logical_rows');
  demand(store.counters.logical_partitions === baseline.unitCount, 'Independent logical verification incomplete');
}
