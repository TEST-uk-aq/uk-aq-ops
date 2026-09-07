import { Worker } from 'node:worker_threads';

// One persistent isolate/WASM instance per slot. No credentials, lock context,
// checkpoint path, adapters or publication callbacks cross this boundary.
export class MigrationWorkerPool {
  constructor(size) {
    if (!Number.isInteger(size) || size < 1 || size > 24) throw new Error('Invalid migration worker pool size');
    this.failure = null;
    this.closed = false;
    this.sequence = 0;
    this.slots = Array.from({ length: size }, () => {
      const worker = new Worker(new URL('./observation_history_migration_worker.mjs', import.meta.url), { env: {} });
      const slot = { worker, pending: null };
      const fail = (error) => {
        this.failure ||= error;
        slot.pending?.reject(error);
        slot.pending = null;
      };
      worker.on('error', fail);
      worker.on('exit', (code) => { if (!this.closed) fail(new Error(`Migration CPU worker exited unexpectedly: ${code}`)); });
      worker.on('message', (message) => {
        const pending = slot.pending;
        if (!pending || message.id !== pending.id) { fail(new Error('Migration worker result identity mismatch')); return; }
        slot.pending = null;
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      });
      return slot;
    });
  }
  run(kind, input) {
    if (this.closed || this.failure) return Promise.reject(this.failure || new Error('Migration worker pool is closed'));
    const slot = this.slots.find((entry) => !entry.pending);
    if (!slot) return Promise.reject(new Error('Migration scheduler exceeded its worker bound'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      slot.pending = { id, resolve, reject };
      try { slot.worker.postMessage({ id, kind, input }, transferableBuffers(input)); }
      catch (error) { slot.pending = null; reject(error); }
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.slots.map((slot) => slot.worker.terminate()));
    this.slots.length = 0;
  }
}

// Only transfer exact owned allocations, never a pooled Buffer slab.
export function transferableBuffers(value, found = new Set()) {
  if (ArrayBuffer.isView(value)) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength && value.buffer instanceof ArrayBuffer) found.add(value.buffer);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) transferableBuffers(child, found);
  }
  return [...found];
}
