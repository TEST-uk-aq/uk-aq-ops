import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "../shared/r2_sigv4.mjs";

function identifies(identity, expected) {
  return identity?.byte_size === expected.byte_size && identity?.sha256 === expected.sha256;
}

function verifiedPublication(result, expected) {
  return result?.verified === true && result.post_put_get_verified === true &&
    result.key === expected.key && identifies(result, expected);
}

export function createV3ParentPublicationBatch({
  parentKeys, latestKey, getObject, putIfChanged, putObject, assertOwned, admit, log, recordReused = () => {},
}) {
  const order = new Map(parentKeys.map((key, index) => [key, index]));
  const staged = new Map();
  const predecessors = new Map();
  let preparationError = null;
  let applying = false;
  let approvedLatest = null;
  let lastVerified = null;
  let attemptedKey = null;

  async function readPredecessor(args) {
    try {
      const object = await getObject(args);
      if (object?.exists === false) return { object, identity: null };
      if (object?.key !== args.key || !Buffer.isBuffer(object.body)) throw new Error(`Cannot pin v3 parent: ${args.key}`);
      return { object, identity: { sha256: sha256Hex(object.body), byte_size: object.body.length, etag: object.etag ?? null } };
    } catch (error) {
      if (error?.status !== 404) throw error;
      return { error, identity: null };
    }
  }

  function stage(object, put, requestBound) {
    const { key } = object;
    if (applying || !order.has(key) || staged.has(key) ||
      (staged.size && order.get(key) <= order.get([...staged.keys()].at(-1)))) {
      throw new Error(`Unexpected v3 parent publication order or key: ${key}`);
    }
    const body = Buffer.from(object.body);
    const planned = { ...object, body, byte_size: body.length, sha256: sha256Hex(body) };
    const unchanged = identifies(predecessors.get(key), planned);
    staged.set(key, { object: planned, put, requestBound: unchanged ? 0 : requestBound, read: false });
    // Private preparation only. The real writer cannot return successful
    // finalisation until every planned parent and latest has origin evidence.
    return { key, bytes: body.length };
  }

  async function verifyReadback(expected) {
    const stored = await getObject({ key: expected.key, r2: expected.r2 });
    if (stored?.key !== expected.key || !stored.body?.equals(expected.body)) {
      throw new Error(`V3 publication readback differs: ${expected.key}`);
    }
  }

  async function beginPublication(key) {
    // The first action is covered by the assertion immediately before batch
    // admission. Each later action checks the same original session again.
    if (attemptedKey !== null) await assertOwned();
    attemptedKey = key;
  }

  return {
    async getObject(args) {
      if (applying || !(order.has(args.key) || args.key === latestKey)) return await getObject(args);
      const planned = staged.get(args.key);
      if (planned) {
        planned.read = true;
        return { key: args.key, body: planned.object.body, bytes: planned.object.byte_size };
      }
      let predecessor;
      try {
        predecessor = await readPredecessor(args);
        const { identity } = predecessor;
        if (predecessors.has(args.key) && !isDeepStrictEqual(identity, predecessors.get(args.key))) {
          throw new Error(`Current v3 parent or latest changed during preparation: ${args.key}`);
        }
        predecessors.set(args.key, identity);
      } catch (error) {
        // The shared hierarchy planner can catch a predecessor read failure as
        // replace-invalid. This batch must not admit after that uncertainty.
        preparationError ??= error;
        throw error;
      }
      if (predecessor.error) throw predecessor.error;
      return predecessor.object;
    },
    async putIfChanged(object) {
      if (!applying) {
        // Day: HEAD/PUT/verified GET, or HEAD and our exact GET on reuse.
        return stage(object, putIfChanged, 3);
      }
      if (object.key !== latestKey || !approvedLatest || attemptedKey === latestKey ||
          !identifies(object, approvedLatest) || !Buffer.from(object.body).equals(approvedLatest.body)) {
        throw new Error(`Publication is outside the admitted v3 latest plan: ${object.key}`);
      }
      await beginPublication(latestKey);
      if (!approvedLatest.unchanged) return await putIfChanged(object);
      await verifyReadback(approvedLatest);
      recordReused(object);
      return { key: latestKey, byte_size: object.byte_size, sha256: object.sha256,
        status: "skipped_unchanged", verified: true, post_put_get_verified: true };
    },
    putObject(object) {
      return stage(object, putObject, 2); // Aggregate PUT and exact GET.
    },
    async publishParents(latest) {
      if (applying) throw new Error("V3 parent batch was already admitted");
      if (preparationError) throw preparationError;
      const complete = latest?.key === latestKey && predecessors.get(latestKey) &&
        parentKeys.every(key => predecessors.has(key)) &&
        [...staged.values()].every(entry => entry.read);
      if (!complete) {
        admit(null);
        return;
      }
      // These origin GETs finish before the remaining allowance is calculated.
      for (const [key, expected] of predecessors) {
        const { identity } = await readPredecessor({ key });
        if (!isDeepStrictEqual(identity, expected)) throw new Error(`V3 batch predecessor changed: ${key}`);
      }
      const latestUnchanged = identifies(predecessors.get(latestKey), latest);
      const remainingRequests = [...staged.values()].reduce(
        (count, entry) => count + entry.requestBound, latestUnchanged ? 2 : 4,
      );
      // Unchanged latest needs an exact GET and the existing durability GET.
      // Changed latest needs HEAD/PUT/verified GET and the durability GET.
      const remainingLockChecks = [...staged.values()].filter(entry => entry.requestBound > 0).length + 1;
      const latestBody = Buffer.from(latest.body);
      await assertOwned();
      admit(remainingRequests, remainingLockChecks);
      applying = true;
      log("admitted", { remaining_r2_request_bound: remainingRequests,
        remaining_lock_check_bound: remainingLockChecks,
        planned_parent_count: remainingLockChecks - 1, proposed_latest_sha256: latest.sha256 });
      for (const [key, entry] of staged) {
        if (entry.requestBound === 0) {
          recordReused(entry.object);
        } else {
          await beginPublication(key);
          const result = await entry.put(entry.object);
          if (result?.ok === false) throw new Error(`V3 parent PUT failed: ${key}`);
          if (entry.put === putIfChanged && result?.status !== "skipped_unchanged") {
            if (!verifiedPublication(result, entry.object)) {
              throw new Error(`V3 day publication has no exact post-PUT proof: ${key}`);
            }
          } else {
            await verifyReadback(entry.object);
          }
        }
        lastVerified = key;
        log("parent_verified", { key, sha256: entry.object.sha256, reused: entry.requestBound === 0 });
      }
      approvedLatest = { ...latest, body: latestBody, unchanged: latestUnchanged };
    },
    async finishLatest(publication) {
      const [evidence] = publication?.objects ?? [];
      if (!approvedLatest || attemptedKey !== latestKey || publication?.ok !== true ||
          publication.objects.length !== 1 || evidence?.key !== latestKey || evidence.verified !== true ||
          evidence.durable !== true || !identifies(evidence, approvedLatest)) {
        throw new Error("V3 latest did not establish the admitted durable identity");
      }
      lastVerified = latestKey;
      await assertOwned();
    },
    get attemptedKey() { return attemptedKey; },
    get lastVerified() { return lastVerified; },
  };
}
