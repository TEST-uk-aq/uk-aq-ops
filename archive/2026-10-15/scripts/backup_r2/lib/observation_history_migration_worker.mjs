import { parentPort, isMainThread } from 'node:worker_threads';
import { transformPinnedObservationPartition, verifyPinnedObservationLogicalMaterial } from './observation_history_migration_v3.mjs';
import { transferableBuffers } from './observation_history_migration_worker_pool.mjs';

if (!isMainThread) parentPort.on('message', async ({ id, kind, input }) => {
  try {
    const result = kind === 'transform' ? await transformPinnedObservationPartition(input)
      : kind === 'verify' ? await verifyPinnedObservationLogicalMaterial(input)
      : (() => { throw new Error('Unsupported migration CPU task'); })();
    parentPort.postMessage({ id, result }, transferableBuffers(result));
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
