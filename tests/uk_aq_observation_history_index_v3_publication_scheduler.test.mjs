import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  buildObservationHistoryIndexV3PublicationPlan,
  encodeObservationHistoryIndexV3Json,
  finalizeObservationHistoryIndexV3Publication,
  MAX_OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONCURRENCY,
} from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY,
  MAX_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY,
  runPruneDailyObservationHistoryV3ConnectorPublication,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
} from "../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";

function artifact({ key, stage = "child_shard", dependencies = [] }) {
  const body = Buffer.from(encodeObservationHistoryIndexV3Json({ key }), "utf8");
  return Object.freeze({
    key,
    body,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
    content_type: "application/json; charset=utf-8",
    publication_stage: stage,
    dependencies: Object.freeze(dependencies.map((entry) => ({
      key: entry.key,
      byte_size: entry.byte_size,
      sha256: entry.sha256,
    }))),
    publication_prerequisites: Object.freeze([]),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("bounded scheduler overlaps independent entries and unlocks dependants only after durability", async () => {
  const childA = artifact({ key: "index/a.json" });
  const childB = artifact({ key: "index/b.json" });
  const parent = artifact({
    key: "index/parent.json",
    stage: "scoped_manifest",
    dependencies: [childA, childB],
  });
  const latest = artifact({
    key: "index/latest.json",
    stage: "latest_global",
    dependencies: [parent],
  });
  const plan = buildObservationHistoryIndexV3PublicationPlan({
    objects: [latest, parent, childB, childA],
  });
  const releases = new Map([
    [childA.key, deferred()],
    [childB.key, deferred()],
  ]);
  const firstPairStarted = deferred();
  const started = [];
  const durable = new Set();
  const stored = new Map();
  let active = 0;
  let maximumActive = 0;
  const progress = [];

  const publication = finalizeObservationHistoryIndexV3Publication({
    plan,
    publicationConcurrency: 2,
    putIfChanged: async ({ key, body }) => {
      started.push(key);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (started.length === 2) firstPairStarted.resolve();
      if (releases.has(key)) await releases.get(key).promise;
      if (key === parent.key) {
        assert.equal(durable.has(childA.key), true);
        assert.equal(durable.has(childB.key), true);
      }
      if (key === latest.key) assert.equal(durable.has(parent.key), true);
      stored.set(key, Buffer.from(body));
      active -= 1;
      return { ok: true, status: "succeeded" };
    },
    getObject: async ({ key }) => ({ body: stored.get(key) }),
    recordDurableEvidence: async ({ key }) => {
      durable.add(key);
      return { durable: true };
    },
    onProgress: (entry) => progress.push(entry),
  });

  await firstPairStarted.promise;
  assert.deepEqual(started, [childA.key, childB.key]);
  assert.equal(maximumActive, 2);
  releases.get(childB.key).resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.includes(parent.key), false);
  releases.get(childA.key).resolve();

  const result = await publication;
  assert.deepEqual(
    result.objects.map((entry) => entry.key),
    plan.entries.map((entry) => entry.key),
  );
  assert.equal(result.publication_diagnostics.configured_concurrency, 2);
  assert.equal(result.publication_diagnostics.maximum_active_publications, 2);
  assert.equal(result.publication_diagnostics.completed_object_count, 4);
  assert.equal(result.publication_diagnostics.newly_written_object_count, 4);
  assert.equal(progress.at(-1).status, "succeeded");
  assert.equal(progress.at(-1).active_publication_count, 0);
});

test("steady-state exact-v3 publication selects the conservative bounded default", () => {
  assert.equal(DEFAULT_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY, 8);
  assert.equal(MAX_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY, 16);
});

test("Prune connector publication forwards concurrency 8 and reports bounded diagnostics", async () => {
  const events = [];
  let selectedConcurrency = null;
  const dayUtc = "2026-08-28";
  const connectorId = 1;
  const pollutantCode = "no2";
  const rows = [0, 1].map((hour) => ({
    connector_id: connectorId,
    station_id: 10,
    timeseries_id: 100,
    pollutant_code: pollutantCode,
    observed_at_utc: `${dayUtc}T0${hour}:00:00.000Z`,
    value: 10 + hour,
    verification_status: null,
  }));

  const result = await runPruneDailyObservationHistoryV3ConnectorPublication({
    client: { query: async () => ({ rows: [] }) },
    partitions: [{ rows }],
    writerLimits: ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
    targetWriterGitSha: "1".repeat(40),
    backedUpAtUtc: "2026-08-29T00:00:00.000Z",
    r2: {},
    withConnectorDayLock: async (_options, callback) => await callback(),
    putAndVerifyParquet: async ({ intent }) => ({
      key: intent.key,
      byte_size: intent.byte_size,
      sha256: intent.sha256,
      stored_sha256_verified: true,
    }),
    publishConnectorScopedCanonicalManifests: async ({ partitions }) => ({
      connector_scope_verified: true,
      parent_state_reread_under_lock: true,
      day_utc: dayUtc,
      connector_id: connectorId,
      current_pollutant_codes: [],
      changed_pollutant_codes: [pollutantCode],
      final_pollutant_codes: [pollutantCode],
      removed_pollutant_codes: [],
      removed_scopes: [],
      pollutant_manifests: partitions.map(({ pollutant_manifest: manifest }) => ({
        key: manifest.key,
        byte_size: manifest.byte_size,
        sha256: manifest.sha256,
        verified: true,
        durable: true,
      })),
      connector_manifest: {
        key: `history/v3/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
        byte_size: 1,
        sha256: "a".repeat(64),
        verified: true,
        durable: true,
      },
      connector_manifest_payload: {},
      prune_eligibility_created: false,
    }),
    putIfChanged: async () => { throw new Error("unexpected lower PUT"); },
    getObject: async () => { throw new Error("unexpected lower GET"); },
    recordDurableEvidence: async () => {
      throw new Error("unexpected lower durability call");
    },
    finalizeV3Publication: async ({ plan, publicationConcurrency, onProgress }) => {
      selectedConcurrency = publicationConcurrency;
      const publicationDiagnostics = {
        status: "succeeded",
        configured_concurrency: publicationConcurrency,
        total_object_count: plan.entries.length,
        reused_object_count: 0,
        newly_written_object_count: plan.entries.length,
        unknown_put_status_object_count: 0,
        completed_object_count: plan.entries.length,
        active_publication_count: 0,
        ready_object_count: 0,
        blocked_object_count: 0,
        maximum_active_publications: publicationConcurrency,
        elapsed_ms: 25,
      };
      onProgress(publicationDiagnostics);
      return {
        ok: true,
        objects: plan.entries.map((entry) => ({
          key: entry.key,
          byte_size: entry.byte_size,
          sha256: entry.sha256,
          verified: true,
          durable: true,
        })),
        publication_diagnostics: publicationDiagnostics,
      };
    },
    diagnosticLog: (event, fields) => events.push({ event, fields }),
  });

  assert.equal(result.ok, true);
  assert.equal(selectedConcurrency, 8);
  const start = events.find((entry) =>
    entry.event === "exact_v3_connector_publication_start"
  );
  const complete = events.find((entry) =>
    entry.event === "exact_v3_connector_publication_complete"
  );
  assert.equal(start.fields.configured_concurrency, 8);
  assert.equal(complete.fields.completed_object_count, complete.fields.total_object_count);
  assert.equal(complete.fields.maximum_active_publications, 8);
});

test("first failure stops new launches while an already-started sibling settles durably", async () => {
  const objects = ["a", "b", "c", "d"].map((name) =>
    artifact({ key: `index/${name}.json` })
  );
  const plan = buildObservationHistoryIndexV3PublicationPlan({ objects });
  const bothStarted = deferred();
  const releaseFailure = deferred();
  const releaseSibling = deferred();
  const started = [];
  const durable = [];
  const failure = new Error("controlled publication failure");
  let firstKey;
  let siblingKey;

  const publication = finalizeObservationHistoryIndexV3Publication({
    plan,
    publicationConcurrency: 2,
    putIfChanged: async ({ key, body }) => {
      started.push(key);
      if (started.length === 1) firstKey = key;
      if (started.length === 2) {
        siblingKey = key;
        bothStarted.resolve();
      }
      if (key === firstKey) {
        await releaseFailure.promise;
        throw failure;
      }
      if (key === siblingKey) await releaseSibling.promise;
      return {
        ok: true,
        status: "succeeded",
        verified: true,
        post_put_get_verified: true,
        key,
        byte_size: body.byteLength,
        sha256: sha256Hex(body),
      };
    },
    getObject: async () => { throw new Error("unexpected GET"); },
    recordDurableEvidence: async ({ key }) => {
      durable.push(key);
      return { durable: true };
    },
  });

  await bothStarted.promise;
  releaseFailure.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  releaseSibling.resolve();
  await assert.rejects(publication, (error) => error === failure);
  assert.deepEqual(started, plan.entries.slice(0, 2).map((entry) => entry.key));
  assert.deepEqual(durable, [siblingKey]);
});

test("budget exhaustion is propagated as the original error after siblings settle", async () => {
  const objects = ["a", "b", "c"].map((name) =>
    artifact({ key: `index/${name}.json` })
  );
  const plan = buildObservationHistoryIndexV3PublicationPlan({ objects });
  const bothStarted = deferred();
  const releaseBudget = deferred();
  const releaseSibling = deferred();
  const started = [];
  const durable = [];
  const budgetError = Object.assign(new Error("budget exhausted"), {
    name: "PhaseBHistoryBudgetExhaustedError",
    code: "PHASE_B_HISTORY_BUDGET_EXHAUSTED",
  });

  const publication = finalizeObservationHistoryIndexV3Publication({
    plan,
    publicationConcurrency: 2,
    putIfChanged: async ({ key, body }) => {
      started.push(key);
      if (started.length === 2) bothStarted.resolve();
      if (key === plan.entries[0].key) {
        await releaseBudget.promise;
        throw budgetError;
      }
      await releaseSibling.promise;
      return {
        ok: true,
        status: "skipped_unchanged",
        skipped: true,
        verified: true,
        post_put_get_verified: true,
        key,
        byte_size: body.byteLength,
        sha256: sha256Hex(body),
      };
    },
    getObject: async () => { throw new Error("unexpected GET"); },
    recordDurableEvidence: async ({ key }) => {
      durable.push(key);
      return { durable: true };
    },
  });

  await bothStarted.promise;
  releaseBudget.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  releaseSibling.resolve();
  await assert.rejects(publication, (error) => error === budgetError);
  assert.equal(started.length, 2);
  assert.equal(durable.length, 1);
});

test("retry-safe reused objects remain verified and counted without a redundant GET", async () => {
  const object = artifact({ key: "index/reused.json" });
  const plan = buildObservationHistoryIndexV3PublicationPlan({ objects: [object] });
  let gets = 0;
  const result = await finalizeObservationHistoryIndexV3Publication({
    plan,
    publicationConcurrency: 4,
    putIfChanged: async (entry) => ({
      ...entry,
      ok: true,
      status: "skipped_unchanged",
      skipped: true,
      verified: true,
      post_put_get_verified: true,
    }),
    getObject: async () => {
      gets += 1;
      return { body: object.body };
    },
    recordDurableEvidence: async () => ({ durable: true }),
  });
  assert.equal(gets, 0);
  assert.equal(result.publication_diagnostics.reused_object_count, 1);
  assert.equal(result.publication_diagnostics.newly_written_object_count, 0);
});

test("serial default preserves plan-order put, verify and durability semantics", async () => {
  const objects = ["a", "b", "c"].map((name) =>
    artifact({ key: `index/${name}.json` })
  );
  const plan = buildObservationHistoryIndexV3PublicationPlan({ objects });
  const stored = new Map();
  const events = [];
  const result = await finalizeObservationHistoryIndexV3Publication({
    plan,
    putIfChanged: async ({ key, body }) => {
      events.push(`put:${key}`);
      stored.set(key, Buffer.from(body));
      return { ok: true, status: "succeeded" };
    },
    getObject: async ({ key }) => {
      events.push(`get:${key}`);
      return { body: stored.get(key) };
    },
    recordDurableEvidence: async ({ key }) => {
      events.push(`durable:${key}`);
      return { durable: true };
    },
  });
  assert.deepEqual(events, plan.entries.flatMap((entry) => [
    `put:${entry.key}`,
    `get:${entry.key}`,
    `durable:${entry.key}`,
  ]));
  assert.equal(result.publication_diagnostics.configured_concurrency, 1);
  assert.equal(result.publication_diagnostics.maximum_active_publications, 1);
});

test("publication concurrency rejects values outside the bounded range", async () => {
  const object = artifact({ key: "index/a.json" });
  const plan = buildObservationHistoryIndexV3PublicationPlan({ objects: [object] });
  const adapters = {
    plan,
    putIfChanged: async () => ({ ok: true }),
    getObject: async () => ({ body: object.body }),
    recordDurableEvidence: async () => ({ durable: true }),
  };
  for (const value of [0, 1.5, "8", MAX_OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONCURRENCY + 1]) {
    await assert.rejects(
      finalizeObservationHistoryIndexV3Publication({
        ...adapters,
        publicationConcurrency: value,
      }),
      /publication concurrency must be an integer/,
    );
  }
});
