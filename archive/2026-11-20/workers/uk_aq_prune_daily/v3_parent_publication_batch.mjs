import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "../shared/r2_sigv4.mjs";

// A changed latest uses HEAD/PUT/GET and the durable evidence GET. The
// accepted post-PUT GET replaces the finaliser's explicit GET on that path.
// An unchanged ETag uses HEAD plus the explicit and durable GETs.
const LATEST_REQUEST_BOUND = 3 + 1;

export function createV3ParentPublicationBatch({
  parentKeys, latestKey, getObject, putIfChanged, putObject, assertOwned, admit, log,
}) {
  const order = new Map(parentKeys.map((key, index) => [key, index]));
  const staged = new Map();
  const predecessors = new Map();
  let publishing = false;
  let lastVerified = null;
  let attemptedKey = null;

  async function readPredecessor(args) {
    try {
      const object = await getObject(args);
      if (object?.exists === false) return { object, identity: null };
      if (!Buffer.isBuffer(object?.body)) throw new Error(`Cannot pin v3 parent: ${args.key}`);
      return { object, identity: { sha256: sha256Hex(object.body), byte_size: object.body.length, etag: object.etag ?? null } };
    } catch (error) {
      if (error?.status !== 404) throw error;
      return { error, identity: null };
    }
  }

  function stage(object, put, requestCount) {
    const { key } = object;
    if (!order.has(key) || staged.has(key) ||
      (staged.size && order.get(key) <= order.get([...staged.keys()].at(-1)))) {
      throw new Error(`Unexpected v3 parent publication order or key: ${key}`);
    }
    const body = Buffer.from(object.body);
    staged.set(key, { object: { ...object, body }, put, requestCount, reads: 0 });
    // Used only inside preparation. Real PUT/readback follows batch admission,
    // and no caller receives finalisation success from this staged result.
    return { key, bytes: body.length };
  }

  return {
    async getObject(args) {
      if (publishing || !(order.has(args.key) || args.key === latestKey)) return await getObject(args);
      const planned = staged.get(args.key);
      if (planned) {
        planned.reads += 1;
        return { key: args.key, body: planned.object.body, bytes: planned.object.body.length };
      }
      const { object, error, identity } = await readPredecessor(args);
      if (predecessors.has(args.key) && !isDeepStrictEqual(identity, predecessors.get(args.key))) {
        throw new Error(`Current v3 parent or latest changed during preparation: ${args.key}`);
      }
      predecessors.set(args.key, identity);
      if (error) throw error;
      return object;
    },
    putIfChanged(object) {
      if (publishing && object.key === latestKey) {
        attemptedKey = latestKey;
        return putIfChanged(object);
      }
      if (publishing) throw new Error(`Unexpected PUT after v3 parent batch: ${object.key}`);
      return stage(object, putIfChanged, 3);
    },
    putObject(object) {
      if (publishing) throw new Error(`Unexpected PUT after v3 parent batch: ${object.key}`);
      return stage(object, putObject, 1);
    },
    async publishParents(latest) {
      const complete = latest?.key === latestKey && predecessors.get(latestKey) &&
        parentKeys.every(key => predecessors.has(key)) &&
        [...staged.values()].every(entry => entry.reads > 0);
      if (!complete) admit(null);
      // These origin GETs are completed before the remaining allowance is
      // calculated. Unchanged aggregate bodies have already been read back.
      for (const [key, expected] of predecessors) {
        const { identity } = await readPredecessor({ key });
        if (!isDeepStrictEqual(identity, expected)) throw new Error(`V3 batch predecessor changed: ${key}`);
      }
      // All overlay reads of one parent expect the same exact body. A single
      // complete origin readback under the continuous lock authenticates those
      // references, including the durable evidence used by the parent result.
      const remainingRequests = [...staged.values()].reduce((count, entry) =>
        count + entry.requestCount + 1, LATEST_REQUEST_BOUND);
      await assertOwned();
      admit(remainingRequests);
      publishing = true;
      log("admitted", { remaining_r2_request_bound: remainingRequests, planned_parent_count: staged.size,
        proposed_latest_sha256: latest.sha256 });
      for (const [key, entry] of staged) {
        attemptedKey = key;
        await entry.put(entry.object);
        const stored = await getObject({ key, r2: entry.object.r2 });
        if (!stored?.body?.equals(entry.object.body)) throw new Error(`V3 parent readback differs: ${key}`);
        lastVerified = key;
        log("parent_verified", { key, sha256: sha256Hex(entry.object.body) });
      }
    },
    get attemptedKey() { return attemptedKey; },
    get lastVerified() { return lastVerified; },
  };
}
