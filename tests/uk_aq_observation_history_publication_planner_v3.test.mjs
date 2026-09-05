import assert from "node:assert/strict";
import test from "node:test";
import { buildObservationHistoryIndexV3PublicationPlan as heapPlan } from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import { buildObservationHistoryIndexV3PublicationPlan as sortedArrayPlan } from "./fixtures/uk_aq_index_v3_sorted_array_reference.mjs";
import { archivePlannerGraph, plannerObject, plannerReference } from "./fixtures/uk_aq_index_v3_planner_graphs.mjs";

function comparePlans(graph) {
  const before = JSON.stringify(graph);
  const expected = sortedArrayPlan(graph);
  const quiet = heapPlan(graph);
  const events = [];
  const observed = heapPlan({ ...graph, onProgress: (event) => events.push(event) });
  // Compare every field and the full serialized bytes, not merely sorted keys.
  assert.deepEqual(quiet, expected);
  assert.deepEqual(observed, expected);
  assert.equal(JSON.stringify(observed), JSON.stringify(expected));
  assert.equal(observed.schedule_sha256, expected.schedule_sha256);
  assert.equal(JSON.stringify(graph), before);
  const total = graph.objects.length;
  assert.deepEqual(events, Array.from({ length: total + 1 }, (_, completed) => ({ completed, total })));
  assert.deepEqual(heapPlan({ ...graph, onProgress() { throw new Error("diagnostics unavailable"); } }), expected);
  return quiet;
}

test("heap preserves complete sorted-array plans for representative deterministic graph shapes", async (t) => {
  const chain = Array.from({ length: 40 }, (_, index) => plannerObject(`chain/${index}`));
  for (let index = 1; index < chain.length; index += 1) chain[index].dependencies.push(plannerReference(chain[index - 1]));
  const wide = Array.from({ length: 512 }, (_, index) => plannerObject(`wide/${String(511 - index).padStart(6, "0")}`));
  const mixed = ["latest_global", "scoped_manifest", "child_shard", "canonical_manifest", "canonical_parquet"].flatMap(
    (stage) => ["z", "a", "é", "\uE000", "\u{10000}"].map((key) => plannerObject(`mixed/${key}/${stage}`, stage)),
  );
  const trigger = plannerObject("unlock/0");
  const siblings = Array.from({ length: 256 }, (_, index) => {
    const object = plannerObject(`unlock/${String(256 - index).padStart(5, "0")}`);
    object.dependencies.push(plannerReference(trigger));
    return object;
  });
  const parentA = plannerObject("parents/a", "scoped_manifest");
  const parentB = plannerObject("parents/b", "scoped_manifest");
  parentA.dependencies.push(plannerReference(siblings[0]));
  parentB.publication_prerequisites.push(plannerReference(siblings[0]));
  const unicode = ["z", "Z", "é", "e\u0301", "中", "😀", "\uE000", "\u{10000}", "\ud800", "\ud801", "\udfff"].map(
    (key) => plannerObject(`unicode/${key}/object`),
  );
  const unlockedTies = ["\udfff", "\ud800", "\ud801"].map((key) => {
    const object = plannerObject(`unicode/${key}/unlocked`);
    object.dependencies.push(plannerReference(trigger));
    return object;
  });
  const external = plannerObject("external/canonical", "canonical_manifest");
  const prerequisite = plannerObject("external/child");
  prerequisite.publication_prerequisites.push(plannerReference(external));
  for (const [name, graph] of [
    ["simple dependency chain", { objects: [...chain].reverse() }],
    ["wide initially eligible siblings", { objects: wide }],
    ["mixed stages and UTF-8 tie-breaking", { objects: mixed }],
    ["wide newly eligible siblings and simultaneous parents", { objects: [parentB, parentA, ...siblings, trigger] }],
    ["disconnected subgraphs", { objects: [...wide, ...chain, prerequisite], externalReferences: [{ ...plannerReference(external), verified: true, durable: true }] }],
    ["UTF-8 versus UTF-16 ordering and stable equal-byte keys", { objects: unicode }],
    ["stable equal-byte keys becoming eligible together", { objects: [...unlockedTies, trigger] }],
    ["external prerequisite", { objects: [prerequisite], externalReferences: [{ ...plannerReference(external), verified: true, durable: true }] }],
    ["archive-shaped hierarchy", archivePlannerGraph(2048, 32)],
  ]) await t.test(name, () => {
    comparePlans(graph);
    comparePlans({ ...graph, objects: [...graph.objects].reverse() });
  });
});

test("heap preserves cycle blockers, validation failures and partial progress", async (t) => {
  const a = plannerObject("cycle/é");
  const b = plannerObject("cycle/z");
  const blocked = plannerObject("cycle/blocked-parent", "scoped_manifest");
  a.dependencies.push(plannerReference(b));
  b.publication_prerequisites.push(plannerReference(a));
  blocked.dependencies.push(plannerReference(a));
  const free = plannerObject("free/leaf");
  const self = plannerObject("cycle/self");
  self.dependencies.push(plannerReference(self));
  const missing = plannerObject("invalid/missing");
  missing.publication_prerequisites.push(plannerReference(free));
  const contradiction = structuredClone(missing);
  contradiction.body = Buffer.from(missing.body);
  contradiction.publication_prerequisites[0].sha256 = "e".repeat(64);
  const conflict = plannerObject("invalid/stage", "canonical_parquet");
  conflict.dependencies.push(plannerReference(free));
  for (const [name, graph, completed] of [
    ["cycle with disconnected completed node", { objects: [blocked, a, free, b] }, 1],
    ["self cycle", { objects: [self] }, 0],
    ["missing prerequisite", { objects: [missing] }, 0],
    ["contradictory prerequisite", { objects: [contradiction, free] }, 0],
    ["stage conflict", { objects: [conflict, free] }, 0],
    ["duplicate key", { objects: [free, free] }, 0],
    ["invalid object identity", { objects: [{ ...free, sha256: "f".repeat(64) }] }, null],
    ["empty graph", { objects: [] }, null],
  ]) await t.test(name, () => {
    let expected;
    try { sortedArrayPlan(graph); } catch (error) { expected = error; }
    assert.ok(expected);
    const events = [];
    assert.throws(() => heapPlan({ ...graph, onProgress: (event) => events.push(event) }), (error) => {
      assert.equal(error.constructor, expected.constructor);
      assert.equal(error.message, expected.message);
      return true;
    });
    assert.throws(() => heapPlan({ ...graph, onProgress() { throw new Error("diagnostic failure"); } }), (error) => error.message === expected.message);
    if (completed === null) assert.deepEqual(events, []);
    else assert.deepEqual(events, Array.from({ length: completed + 1 }, (_, count) => ({ completed: count, total: graph.objects.length })));
    assert.ok(events.every((event) => event.completed < event.total));
  });
});
