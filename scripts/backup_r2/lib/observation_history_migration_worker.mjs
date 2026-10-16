import { parentPort, isMainThread } from 'node:worker_threads';
import v8 from 'node:v8';
import { transformPinnedObservationPartition, verifyPinnedObservationLogicalMaterial } from './observation_history_migration_v3.mjs';
import { transferableBuffers } from './observation_history_migration_worker_pool.mjs';

let completedTasks = 0;
const memorySample = () => {
  completedTasks += 1;
  if (completedTasks !== 1 && completedTasks % 32 !== 0) return undefined;
  const usage = process.memoryUsage();
  return {
    heap_used: usage.heapUsed,
    heap_total: usage.heapTotal,
    external: usage.external,
    array_buffers: usage.arrayBuffers,
    heap_limit: v8.getHeapStatistics().heap_size_limit,
  };
};

if (!isMainThread) parentPort.on('message', async ({ id, kind, input }) => {
  try {
    const result = kind === 'transform' ? await transformPinnedObservationPartition(input)
      : kind === 'verify' ? await verifyPinnedObservationLogicalMaterial(input)
      : (() => { throw new Error('Unsupported migration CPU task'); })();
    parentPort.postMessage({ id, result, memory: memorySample() }, transferableBuffers(result));
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error), memory: memorySample() });
  }
});
