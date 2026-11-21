#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { hasRequiredR2Config, isStrongR2Etag, r2GetObject, r2PutObjectConditional, sha256Hex } from "../../workers/shared/r2_sigv4.mjs";
import { withHistoryWriterClient, withObservationsGlobalOperationLock } from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { resolveObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { verifyObservationHistoryV3UnlistedScope } from "../../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";
import { verifyObservationHistoryV3ExternalReferences } from "../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  encodeObservationHistoryIndexV3Json,
  updateObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
} from "../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifestKey, buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest, validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { buildHistoryV2ConnectorManifest, buildHistoryV2ConnectorManifestKey, buildHistoryV2DayManifestKey } from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import { validateCanonicalHistoryV2Manifest } from "../../workers/shared/uk_aq_r2_history_manifest_validation.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const OWNER = "observation_history_v3_latest_repair";

function exactObject(object, key) {
  if (object?.key !== key || !Buffer.isBuffer(object.body) || object.bytes !== object.body.length) {
    throw new Error(`Invalid R2 object response: ${key}`);
  }
  return { key, byte_size: object.bytes, sha256: sha256Hex(object.body), etag: object.etag };
}

function pinnedObject(object, key) {
  const identity = exactObject(object, key);
  if (!isStrongR2Etag(identity.etag)) throw new Error(`Strong ETag required: ${key}`);
  return identity;
}

function validatedLatest(object, key) {
  const identity = pinnedObject(object, key);
  const body = object.body.toString("utf8");
  const payload = JSON.parse(body);
  if (!object.body.equals(Buffer.from(encodeObservationHistoryIndexV3Json(payload)))) {
    throw new Error(`Latest is not byte-canonical: ${key}`);
  }
  return validateObservationHistoryExactLeafIndexV3LatestRegistry({
    artifact: { ...identity, kind: "observation_history_index_v3_latest_global",
      publication_stage: "latest_global", body, payload },
  });
}

function selectChild(parent, field, value, key) {
  const matches = parent.filter(child => child?.[field] === value);
  if (matches.length !== 1 || matches[0].manifest_key !== key) {
    throw new Error(`Expected one canonical reference to ${key}`);
  }
  return matches[0];
}

function canonicalChildren(manifest, field, identifier) {
  const children = manifest[field];
  if (!Array.isArray(children) || !children.length ||
      !isDeepStrictEqual(children, manifest.child_manifests) ||
      new Set(children.map(child => child?.[identifier])).size !== children.length) {
    throw new Error(`Canonical child descriptors disagree: ${manifest.manifest_key}`);
  }
  return children;
}

async function getCanonicalScope({ getObject, generation, rootObject, dayUtc, connectorId }) {
  const basePrefix = generation.observations_prefix;
  const aggregate = (object, kind, reference) => {
    const body = object.body;
    const manifest = validateR2HistoryV2ObservationsAggregateManifest(JSON.parse(body), { basePrefix });
    if (manifest.kind !== `uk_aq_observations_${kind}_manifest` ||
      (reference && manifest.content_hash !== reference.content_hash) ||
      !body.equals(serializeR2HistoryV2ObservationsAggregateManifest(manifest, { basePrefix }))) {
      throw new Error(`Observation hierarchy identity disagrees: ${object.key}`);
    }
    return manifest;
  };
  const canonical = (object, kind, reference, fields) => {
    const manifest = JSON.parse(object.body);
    validateCanonicalHistoryV2Manifest(manifest, {
      manifest_kind: kind, domain: "observations", day_utc: dayUtc, manifest_key: object.key, ...fields,
    });
    if (manifest.manifest_hash !== reference.manifest_hash) {
      throw new Error(`Canonical manifest identity disagrees: ${object.key}`);
    }
    return manifest;
  };

  const root = aggregate(rootObject, "root");
  const year = Number(dayUtc.slice(0, 4));
  const month = dayUtc.slice(5, 7);
  const yearKey = buildR2HistoryV2ObservationsYearManifestKey(basePrefix, year);
  const yearRef = selectChild(root.children, "year", year, yearKey);
  const yearManifest = aggregate(await getObject({ key: yearKey }), "year", yearRef);
  const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(basePrefix, year, month);
  const monthRef = selectChild(yearManifest.children, "month", month, monthKey);
  const monthManifest = aggregate(await getObject({ key: monthKey }), "month", monthRef);
  if (yearManifest.year !== year || monthManifest.year !== year || monthManifest.month !== month) {
    throw new Error("Observation hierarchy year or month is inconsistent");
  }
  const dayKey = buildHistoryV2DayManifestKey(basePrefix, dayUtc);
  const dayRef = selectChild(monthManifest.children, "day_utc", dayUtc, dayKey);
  const day = canonical(await getObject({ key: dayKey }), "day", dayRef);
  const connectorKey = buildHistoryV2ConnectorManifestKey(basePrefix, dayUtc, connectorId);
  const connectorRef = selectChild(canonicalChildren(day, "connector_manifests", "connector_id"),
    "connector_id", connectorId, connectorKey);
  const connector = canonical(await getObject({ key: connectorKey }), "connector", connectorRef, { connector_id: connectorId });
  for (const field of ["row_count", "source_row_count", "file_count", "total_bytes", "pollutant_codes"]) {
    if (!isDeepStrictEqual(connectorRef[field], connector[field])) {
      throw new Error(`Day manifest disagrees with the selected connector: ${field}`);
    }
  }
  return { root, connector, pollutants: canonicalChildren(connector, "pollutant_manifests", "pollutant_code") };
}

export function verifyAddOnlyLatestDiff(before, after, selected, dayUtc, connectorId) {
  const scopeKey = root => JSON.stringify([root.day_utc, root.connector_id, root.pollutant_code]);
  const previous = new Map(before.roots.map(root => [scopeKey(root), root]));
  const proposed = new Map(after.roots.map(root => [scopeKey(root), root]));
  for (const [id, root] of previous) {
    if (!isDeepStrictEqual(proposed.get(id), root)) throw new Error(`Existing registry entry changed: ${id}`);
  }
  const expected = new Map(selected.map(({ key, byte_size, sha256 }) => [key, { key, byte_size, sha256 }]));
  const additions = after.roots.filter(root => !previous.has(scopeKey(root)));
  if (!expected.size || expected.size !== selected.length || additions.length !== expected.size ||
      additions.some(({ day_utc, connector_id, key, byte_size, sha256 }) => day_utc !== dayUtc ||
        connector_id !== connectorId || !isDeepStrictEqual(expected.get(key), { key, byte_size, sha256 }))) {
    throw new Error("Registry diff is not the complete approved add-only scope");
  }
  const totals = ({ artifact }) => {
    const day = artifact.payload.day_summaries.find(summary => summary.day_utc === dayUtc);
    return { scopes: day?.scoped_root_count ?? 0, rows: day?.row_count ?? 0 };
  };
  const beforeDay = totals(before);
  const afterDay = totals(after);
  const addedRows = additions.reduce((sum, scope) => sum + scope.row_count, 0);
  if (afterDay.scopes - beforeDay.scopes !== additions.length || afterDay.rows - beforeDay.rows !== addedRows ||
      after.artifact.payload.total_rows - before.artifact.payload.total_rows !== addedRows) {
    throw new Error("Registry row or scope totals disagree");
  }
  return { unchanged_scope_count: previous.size, additions, day_before: beforeDay, day_after: afterDay,
    added_scope_count: additions.length, added_row_count: addedRows };
}

async function verifyPlan({ getObject, assertOwned, generation, dayUtc, connectorId, evidence, target }) {
  await assertOwned();
  const rootKey = generation.observations_root_key;
  const latestKey = generation.observations_timeseries_latest_key;
  const rootObject = await getObject({ key: rootKey });
  const rootIdentity = pinnedObject(rootObject, rootKey);
  const latest = await getObject({ key: latestKey });
  const predecessor = pinnedObject(latest, latestKey);
  const before = validatedLatest(latest, latestKey);
  if (before.roots.some(root => root.day_utc === dayUtc && root.connector_id === connectorId)) {
    throw new Error("Target connector is already partly or fully listed in latest");
  }
  const { root, connector, pollutants } = await getCanonicalScope({ getObject, generation, rootObject, dayUtc, connectorId });
  const scopes = [];
  const canonicalPollutants = [];
  let indexObjectCount = 0;
  for (const descriptor of pollutants) {
    await assertOwned();
    const verified = await verifyObservationHistoryV3UnlistedScope({
      getObject, observationsPrefix: generation.observations_prefix,
      indexRoot: generation.observations_timeseries_index_prefix,
      scope: { day_utc: dayUtc, connector_id: connectorId, pollutant_code: descriptor.pollutant_code }, descriptor,
    });
    indexObjectCount += verified.verification_object_count;
    scopes.push(verified.artifact);
    canonicalPollutants.push(verified.canonical_manifest);
  }
  const rebuiltConnector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc, connectorId, runId: connector.run_id, manifestKey: connector.manifest_key,
    pollutantManifests: canonicalPollutants, writerGitSha: connector.writer_git_sha, backedUpAtUtc: connector.backed_up_at_utc,
  });
  if (rebuiltConnector.manifest_hash !== connector.manifest_hash) {
    throw new Error("Canonical connector does not match its verified pollutant manifests");
  }
  const retained = await verifyObservationHistoryV3ExternalReferences({
    references: before.roots, getObject, reuseEvidence: false,
  });
  if (retained.has_failure) throw retained.failure;
  const proposed = updateObservationHistoryExactLeafIndexV3Latest({ existingLatest: before.artifact,
    replacementScopedManifests: scopes, removedScopes: [] });
  const after = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: proposed });
  const diff = verifyAddOnlyLatestDiff(before, after, scopes, dayUtc, connectorId);
  if (diff.added_row_count !== Number(connector.row_count)) throw new Error("Canonical connector row count disagrees with the index proof");
  const plan = {
    version: 1, target, day_utc: dayUtc, connector_id: connectorId, interruption_evidence: evidence,
    canonical_root: { ...rootIdentity, content_hash: root.content_hash },
    canonical_connector: { key: connector.manifest_key, manifest_hash: connector.manifest_hash },
    predecessor, proposed: { key: proposed.key, byte_size: proposed.byte_size, sha256: proposed.sha256 },
    backup_key: `_ops/observation-history/latest-recovery/${predecessor.sha256}.json`,
    dependency_evidence: { selected_index_objects: indexObjectCount, selected_parquet_files: Number(connector.file_count),
      retained_index_scopes: retained.evidence_by_key.size },
    ...diff,
  };
  const recheck = async () => {
    for (const identity of [rootIdentity, predecessor]) {
      if (!isDeepStrictEqual(pinnedObject(await getObject({ key: identity.key }), identity.key), identity)) {
        throw new Error(`Locked authority changed: ${identity.key}`);
      }
    }
    await assertOwned();
  };
  await recheck();
  return { plan, planSha: sha256Hex(JSON.stringify(plan)), recheck, before, scopes, proposed };
}

export async function publishApprovedLatest({ verified, approvedPlanSha, getObject, putConditional, assertOwned, onAttempt }) {
  const { plan, planSha, before, proposed, scopes, recheck } = verified;
  if (approvedPlanSha !== planSha) throw new Error("Fresh locked plan differs from the approved plan");
  const backup = exactObject(await getObject({ key: plan.backup_key }), plan.backup_key);
  if (backup.byte_size !== plan.predecessor.byte_size || backup.sha256 !== plan.predecessor.sha256) {
    throw new Error("Durable backup does not match the locked latest predecessor");
  }
  await recheck();
  onAttempt(plan);
  await putConditional({ key: proposed.key, body: Buffer.from(proposed.body), sha256: proposed.sha256,
    content_type: "application/json", if_match: plan.predecessor.etag });
  const stored = await getObject({ key: proposed.key });
  const readback = pinnedObject(stored, proposed.key);
  if (readback.sha256 !== proposed.sha256 || readback.byte_size !== proposed.byte_size ||
      !stored.body.equals(Buffer.from(proposed.body))) throw new Error("Latest publish readback is unconfirmed");
  verifyAddOnlyLatestDiff(before, validatedLatest(stored, proposed.key), scopes, plan.day_utc, plan.connector_id);
  await assertOwned();
  return { ...readback, backup };
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    day: { type: "string" }, connector: { type: "string" }, evidence: { type: "string" },
    "approved-plan-sha": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: plan|apply --day YYYY-MM-DD --connector ID --evidence REF [--approved-plan-sha SHA256 (apply only)]");
    return;
  }
  const [mode] = positionals;
  const dayUtc = values.day;
  const connectorId = Number(values.connector);
  const date = new Date(`${dayUtc}T00:00:00Z`);
  const approved = values["approved-plan-sha"];
  if (positionals.length !== 1 || !["plan", "apply"].includes(mode) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== dayUtc ||
      !/^[1-9]\d*$/.test(values.connector) || !Number.isSafeInteger(connectorId) || !values.evidence?.trim() ||
      (mode === "apply" ? !SHA256.test(approved) : approved !== undefined)) {
    throw new Error("Invalid arguments. Use --help for usage");
  }
  const env = process.env;
  const generation = resolveObservationHistoryGeneration(env);
  const { r2 } = resolveR2HistoryIndexConfig(env);
  if (generation.version !== "v3" || !hasRequiredR2Config(r2)) throw new Error("Selected profile needs complete v3 R2 configuration");
  const databaseUrl = env.SUPABASE_DB_URL || env.DATABASE_URL;
  let lockDatabase;
  try {
    lockDatabase = new URL(databaseUrl);
  } catch {
    throw new Error("Selected profile needs a dedicated-session PostgreSQL connection URL");
  }
  if (!["postgres:", "postgresql:"].includes(lockDatabase.protocol) || !lockDatabase.hostname) {
    throw new Error("Selected profile needs a dedicated-session PostgreSQL connection URL");
  }
  const target = { bucket: r2.bucket, endpoint_sha256: sha256Hex(r2.endpoint), profile: env.UK_AQ_ENV_NAME ?? null,
    lock_database_sha256: sha256Hex(JSON.stringify([lockDatabase.host, lockDatabase.pathname, lockDatabase.username])) };
  const locked = callback => withHistoryWriterClient(databaseUrl, client => withObservationsGlobalOperationLock({
    client, owner: OWNER, runId: randomUUID(),
  }, (_identity, lock) => callback({
    assertOwned: lock.assertOwned,
    getObject: async ({ key }) => {
      lock.assertHeld();
      const object = await r2GetObject({ r2, key, accept_encoding_identity: true });
      lock.assertHeld();
      exactObject(object, key);
      return object;
    },
    putConditional: args => {
      lock.assertHeld();
      if (args.key !== generation.observations_timeseries_latest_key) throw new Error("Invalid canonical write target");
      return r2PutObjectConditional({ ...args, r2 });
    },
  })), { applicationName: OWNER });

  let attempted;
  try {
    const result = await locked(async io => {
      const verified = await verifyPlan({ ...io, generation, dayUtc, connectorId, evidence: values.evidence, target });
      if (mode === "plan") return { ...verified.plan, plan_sha256: verified.planSha };
      const readback = await publishApprovedLatest({ ...io, verified, approvedPlanSha: approved,
        onAttempt: plan => { attempted = plan; } });
      return { status: "verified", ...verified.plan, plan_sha256: verified.planSha, readback };
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (attempted && error.code !== "R2_PRECONDITION_FAILED") {
      // Never attempt a second write. A new session can only inspect current bytes.
      let reconciliation;
      try {
        reconciliation = await locked(async ({ getObject, assertOwned }) => {
          await assertOwned();
          const key = attempted.proposed.key;
          const live = pinnedObject(await getObject({ key }), key);
          await assertOwned();
          const matches = expected => expected.byte_size === live.byte_size && expected.sha256 === live.sha256;
          return { live, status: matches(attempted.proposed) ? "proposed_current" :
            matches(attempted.predecessor) ? "predecessor_current" : "different_current_authority" };
        });
      } catch (inspectError) {
        reconciliation = { status: "unresolved", error: inspectError.message };
      }
      console.error(JSON.stringify({ plan_sha256: approved, predecessor: attempted.predecessor,
        proposed: attempted.proposed, reconciliation }));
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
