import { computeObservationContentHash, validateObservationContentHashMetadata } from "../shared/uk_aq_observation_content_hash.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { validateCanonicalHistoryV2Manifest } from "../shared/uk_aq_r2_history_manifest_validation.mjs";
import { buildHistoryV2ConnectorManifestKey, buildHistoryV2DayManifestKey, buildHistoryV2PollutantManifestKey } from "../shared/uk_aq_r2_history_canonical.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
} from "../shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { encodeObservationHistoryIndexV3Json } from "../shared/uk_aq_observation_history_index_v3.mjs";
import { r2GetObject, sha256Hex } from "../shared/r2_sigv4.mjs";

function isNotFound(error) {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status !== undefined && status !== null) return Number(status) === 404;
  return /^(?:R2 GET failed \(404\)|NoSuchKey\b)/i.test(String(error?.message || ""));
}

async function readOptional(getObject, r2, key) {
  try {
    const result = await getObject({ r2, key });
    return result?.exists === false ? null : Buffer.from(result.body);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function parse(body, key) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`Invalid canonical observation manifest JSON: ${key}`);
  }
}

async function aggregate(getObject, r2, prefix, key, kind) {
  const body = await readOptional(getObject, r2, key);
  if (!body) throw new Error(`Committed observation hierarchy child is missing: ${key}`);
  const value = validateR2HistoryV2ObservationsAggregateManifest(parse(body, key), { basePrefix: prefix });
  if (value.kind !== kind || !body.equals(serializeR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: prefix }))) {
    throw new Error(`Committed observation hierarchy identity disagrees: ${key}`);
  }
  return value;
}

function oneChild(children, field, value, key) {
  const matches = children.filter((child) => child?.[field] === value);
  if (matches.length > 1) throw new Error(`Duplicate committed observation hierarchy child: ${key}`);
  return matches[0] || null;
}

async function manifest(getObject, r2, key, expected, pinnedHash) {
  const body = await readOptional(getObject, r2, key);
  if (!body) throw new Error(`Committed observation manifest is missing: ${key}`);
  const value = parse(body, key);
  validateCanonicalHistoryV2Manifest(value, { history_version: "v2", domain: "observations", manifest_key: key, ...expected });
  if (value.manifest_hash !== pinnedHash) throw new Error(`Committed observation manifest identity disagrees: ${key}`);
  return value;
}

function matchingReferences(parent, primary, alias, field, expectedKey) {
  const children = parent[primary];
  const aliases = parent[alias];
  if (!Array.isArray(children) || !Array.isArray(aliases) || JSON.stringify(children) !== JSON.stringify(aliases)) {
    throw new Error(`Committed observation manifest child aliases disagree: ${expectedKey}`);
  }
  const ids = new Set();
  for (const child of children) {
    if (ids.has(child?.[field])) throw new Error(`Duplicate committed observation manifest child: ${expectedKey}`);
    ids.add(child?.[field]);
  }
  return children;
}

async function currentIndexAuthority(getObject, r2, dayUtc, connectorId) {
  const key = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY;
  const body = await readOptional(getObject, r2, key);
  if (!body) throw new Error(`Current index_v3 latest authority is missing: ${key}`);
  const payload = parse(body, key);
  if (body.toString("utf8") !== encodeObservationHistoryIndexV3Json(payload)) {
    throw new Error(`Current index_v3 latest authority is not canonical: ${key}`);
  }
  const { roots } = validateObservationHistoryExactLeafIndexV3LatestRegistry({
    artifact: {
      kind: "observation_history_index_v3_latest_global",
      publication_stage: "latest_global", key, payload,
      body: body.toString("utf8"), byte_size: body.length, sha256: sha256Hex(body),
    },
  });
  return roots.filter((root) => root.day_utc === dayUtc && root.connector_id === connectorId);
}

async function pinnedIndexJson(getObject, r2, reference, expectedKey) {
  if (reference?.key !== expectedKey || !Number.isSafeInteger(reference?.byte_size) ||
      !/^[0-9a-f]{64}$/.test(String(reference?.sha256 || ""))) {
    throw new Error(`Current index_v3 reference is invalid: ${expectedKey}`);
  }
  const body = await readOptional(getObject, r2, expectedKey);
  if (!body || body.length !== reference.byte_size || sha256Hex(body) !== reference.sha256) {
    throw new Error(`Current index_v3 pinned identity disagrees: ${expectedKey}`);
  }
  const payload = parse(body, expectedKey);
  if (body.toString("utf8") !== encodeObservationHistoryIndexV3Json(payload)) {
    throw new Error(`Current index_v3 object is not canonical: ${expectedKey}`);
  }
  return payload;
}

async function verifyCommittedIndexBinding(getObject, r2, root, pollutant, pollutantBody) {
  const indexRoot = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT;
  const scope = `day_utc=${root.day_utc}/connector_id=${root.connector_id}/pollutant_code=${root.pollutant_code}`;
  const scoped = await pinnedIndexJson(getObject, r2, root, `${indexRoot}/${scope}/manifest.json`);
  if (scoped.kind !== "observation_timeseries_physical_leaf_scoped_manifest" ||
      scoped.index_generation !== "v3" || scoped.history_version !== "v2" ||
      scoped.day_utc !== root.day_utc || scoped.connector_id !== root.connector_id ||
      scoped.pollutant_code !== root.pollutant_code || scoped.coverage?.row_count !== root.row_count ||
      root.row_count !== pollutant.row_count) {
    throw new Error(`Current index_v3 scoped coverage disagrees: ${root.key}`);
  }
  const alignedKey = `${indexRoot}/_aligned/${scope}/manifest.json`;
  const aligned = await pinnedIndexJson(getObject, r2, scoped.source_aligned_scoped_manifest, alignedKey);
  const canonical = aligned.canonical_source_manifest;
  if (aligned.kind !== "observation_timeseries_aligned_source_manifest" ||
      aligned.index_generation !== "v3" || aligned.history_version !== "v2" ||
      aligned.day_utc !== root.day_utc || aligned.connector_id !== root.connector_id ||
      aligned.pollutant_code !== root.pollutant_code ||
      canonical?.key !== pollutant.manifest_key || canonical?.byte_size !== pollutantBody.length ||
      canonical?.sha256 !== sha256Hex(pollutantBody) ||
      canonical?.manifest_hash !== pollutant.manifest_hash ||
      canonical?.observation_content_hash !== pollutant.observation_content_hash ||
      canonical?.row_count !== pollutant.row_count) {
    throw new Error(`Current index_v3 canonical binding disagrees: ${alignedKey}`);
  }
}

export class PruneCommittedHistoryGuardError extends Error {
  constructor({ dayUtc, connectorId, previousAuthority, reason, nextAction = "authorised_canonical_reconciliation_required", isolatable = false }) {
    super(`Prune Daily canonical replacement blocked for connector=${connectorId} day_utc=${dayUtc}: previous_authority=${previousAuthority}; reason=${reason}; next_action=${nextAction}; retain IngestDB rows`);
    this.name = "PruneCommittedHistoryGuardError";
    this.code = "PRUNE_COMMITTED_HISTORY_REPLACEMENT_BLOCKED";
    this.previous_authority = previousAuthority;
    this.reason = reason;
    this.next_action = nextAction;
    this.isolatable = isolatable;
  }
}

// Called with the frozen source, inside the existing publication lock and before
// the complete-snapshot writer receives any rows. Only root-reachable manifests
// are committed authority; loose same-key objects can be interrupted artefacts.
async function inspectPruneFrozenConnectorSnapshot({
  r2, observationsPrefix, dayUtc, connectorId, rows, getObject = r2GetObject,
  onOriginalAuthority = null,
}) {
  const prefix = observationsPrefix;
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  const rootBody = await readOptional(getObject, r2, rootKey);
  if (!rootBody) throw new Error(`Current observations root is missing; absence of committed history is unproven: ${rootKey}`);
  const root = validateR2HistoryV2ObservationsAggregateManifest(parse(rootBody, rootKey), { basePrefix: prefix });
  if (root.kind !== "uk_aq_observations_root_manifest" ||
      !rootBody.equals(serializeR2HistoryV2ObservationsAggregateManifest(root, { basePrefix: prefix }))) {
    throw new Error(`Committed observation root identity disagrees: ${rootKey}`);
  }
  const indexRoots = await currentIndexAuthority(getObject, r2, dayUtc, connectorId);
  const hierarchyKeys = [rootKey];
  const firstPublication = (parentKey, childField, childIdentity) => {
    if (indexRoots.length) throw new Error(`Current index_v3 authority contradicts absent connector hierarchy: ${dayUtc}/${connectorId}`);
    // These are the ORIGINAL admitted root-reachable facts, before any PUT.
    // The latest registry only corroborates the hierarchy; it is not a parent.
    // Optional retention must never alter canonical admission or its return.
    try {
      onOriginalAuthority?.({ admission: "first_publication",
        membership: "authoritative_empty", row_count: 0,
        observations_root_key: rootKey, hierarchy_keys: [...hierarchyKeys],
        authority_key: parentKey,
        absence: { parent_key: parentKey, child_field: childField, child_identity: childIdentity },
        index_discovery_key: DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
        previous_authority: null });
    } catch { /* Optional original evidence cannot change canonical admission. */ }
    return { admission: "first_publication", previous_authority: null };
  };
  const year = Number(dayUtc.slice(0, 4));
  const month = dayUtc.slice(5, 7);
  const yearKey = buildR2HistoryV2ObservationsYearManifestKey(prefix, year);
  const yearRef = oneChild(root.children, "year", year, rootKey);
  if (!yearRef) return firstPublication(rootKey, "year", year);
  if (yearRef.manifest_key !== yearKey) throw new Error(`Committed observation year key disagrees: ${rootKey}`);
  const yearManifest = await aggregate(getObject, r2, prefix, yearKey, "uk_aq_observations_year_manifest");
  if (yearManifest.year !== year || yearManifest.content_hash !== yearRef.content_hash) throw new Error(`Committed observation year identity disagrees: ${yearKey}`);
  hierarchyKeys.push(yearKey);
  const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(prefix, year, month);
  const monthRef = oneChild(yearManifest.children, "month", month, yearKey);
  if (!monthRef) return firstPublication(yearKey, "month", month);
  if (monthRef.manifest_key !== monthKey) throw new Error(`Committed observation month key disagrees: ${yearKey}`);
  const monthManifest = await aggregate(getObject, r2, prefix, monthKey, "uk_aq_observations_month_manifest");
  if (monthManifest.year !== year || monthManifest.month !== month || monthManifest.content_hash !== monthRef.content_hash) throw new Error(`Committed observation month identity disagrees: ${monthKey}`);
  hierarchyKeys.push(monthKey);
  const dayKey = buildHistoryV2DayManifestKey(prefix, dayUtc);
  const dayRef = oneChild(monthManifest.children, "day_utc", dayUtc, monthKey);
  if (!dayRef) return firstPublication(monthKey, "day_utc", dayUtc);
  if (dayRef.manifest_key !== dayKey) throw new Error(`Committed observation day key disagrees: ${monthKey}`);
  const day = await manifest(getObject, r2, dayKey, { manifest_kind: "day", day_utc: dayUtc }, dayRef.manifest_hash);
  hierarchyKeys.push(dayKey);
  const connectors = matchingReferences(day, "connector_manifests", "child_manifests", "connector_id", dayKey);
  const connectorRef = oneChild(connectors, "connector_id", connectorId, dayKey);
  if (!connectorRef) return firstPublication(dayKey, "connector_id", connectorId);
  const connectorKey = buildHistoryV2ConnectorManifestKey(prefix, dayUtc, connectorId);
  if (connectorRef.manifest_key !== connectorKey) throw new Error(`Committed observation connector key disagrees: ${dayKey}`);
  const authority = `${connectorKey}#${connectorRef.manifest_hash}`;
  if (!indexRoots.length) throw new Error("Committed connector has no final index_v3 scope; original unfinished attempt identity is unavailable");
  let connector;
  try {
    connector = await manifest(getObject, r2, connectorKey, { manifest_kind: "connector", day_utc: dayUtc, connector_id: connectorId }, connectorRef.manifest_hash);
    const children = matchingReferences(connector, "pollutant_manifests", "child_manifests", "pollutant_code", connectorKey);
    const byCode = new Map();
    for (const row of rows) {
      const code = row.pollutant_code;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(row);
    }
    if (indexRoots.length !== children.length || new Set(indexRoots.map((entry) => entry.pollutant_code)).size !== children.length) {
      throw new Error("Committed pollutant set and final index_v3 scopes disagree");
    }
    const sourceDifferences = [];
    for (const child of children) {
      const code = child.pollutant_code;
      const partition = byCode.get(code);
      const childKey = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, code);
      if (child.manifest_key !== childKey) throw new Error(`Committed pollutant key disagrees for pollutant=${code}`);
      const indexRoot = indexRoots.find((entry) => entry.pollutant_code === code);
      if (!indexRoot) throw new Error(`Committed pollutant=${code} has no final index_v3 scope`);
      const pollutantBody = await readOptional(getObject, r2, childKey);
      if (!pollutantBody) throw new Error(`Committed pollutant manifest is missing: ${childKey}`);
      const pollutant = parse(pollutantBody, childKey);
      validateCanonicalHistoryV2Manifest(pollutant, { history_version: "v2", domain: "observations", manifest_kind: "pollutant", day_utc: dayUtc, connector_id: connectorId, pollutant_code: code, manifest_key: childKey });
      if (pollutant.manifest_hash !== child.manifest_hash) throw new Error(`original complete publication identity cannot be proved after same-key child advance: ${childKey}`);
      validateObservationContentHashMetadata(pollutant, { rowCount: pollutant.row_count });
      await verifyCommittedIndexBinding(getObject, r2, indexRoot, pollutant, pollutantBody);
      if (!partition) {
        sourceDifferences.push(`frozen source omits committed pollutant=${code}`);
      } else if (pollutant.observation_content_hash_contract_version !== 1 ||
                 pollutant.observation_content_hash !== computeObservationContentHash(partition).observation_content_hash ||
                 pollutant.observation_content_hash_row_count !== partition.length) {
        sourceDifferences.push(`frozen observations differ from committed pollutant=${code}`);
      }
    }
    if (children.length !== byCode.size) sourceDifferences.unshift("frozen pollutant child set differs from committed history");
    if (sourceDifferences.length) {
      throw new PruneCommittedHistoryGuardError({
        dayUtc, connectorId, previousAuthority: authority,
        reason: sourceDifferences.join("; ").slice(0, 1800), isolatable: true,
      });
    }
  } catch (error) {
    if (error instanceof PruneCommittedHistoryGuardError) throw error;
    throw new Error(`complete replacement authority cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new PruneCommittedHistoryGuardError({
    dayUtc, connectorId, previousAuthority: authority,
    reason: "verified already-committed identical history; original Prune attempt and complete source identity cannot be proved from canonical content alone",
    nextAction: "review_original_publication_evidence_or_duplicate_historical_rows",
    isolatable: true,
  });
}

export async function admitPruneFrozenConnectorSnapshot(args) {
  try {
    return await inspectPruneFrozenConnectorSnapshot(args);
  } catch (error) {
    if (error instanceof PruneCommittedHistoryGuardError) throw error;
    throw new PruneCommittedHistoryGuardError({
      dayUtc: args.dayUtc,
      connectorId: args.connectorId,
      previousAuthority: `${buildR2HistoryV2ObservationsRootManifestKey(args.observationsPrefix)} (connector authority unverified)`,
      reason: `committed hierarchy could not be authenticated: ${error instanceof Error ? error.message : String(error)}`,
      nextAction: "repair_or_authenticate_canonical_root_and_index_before_prune",
    });
  }
}
