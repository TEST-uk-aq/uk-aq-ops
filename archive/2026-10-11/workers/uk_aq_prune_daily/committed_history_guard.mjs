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
import { r2GetObject } from "../shared/r2_sigv4.mjs";

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

export class PruneCommittedHistoryGuardError extends Error {
  constructor({ dayUtc, connectorId, previousAuthority, reason }) {
    super(`Prune Daily canonical replacement blocked for connector=${connectorId} day_utc=${dayUtc}: previous_authority=${previousAuthority}; reason=${reason}; action=reconstruct a complete authoritative connector/day or use separately authorised reconciliation; retain IngestDB rows`);
    this.name = "PruneCommittedHistoryGuardError";
    this.code = "PRUNE_COMMITTED_HISTORY_REPLACEMENT_BLOCKED";
    this.previous_authority = previousAuthority;
    this.reason = reason;
  }
}

// Called with the frozen source, inside the existing publication lock and before
// the complete-snapshot writer receives any rows. Only root-reachable manifests
// are committed authority; loose same-key objects can be interrupted artefacts.
async function inspectPruneFrozenConnectorSnapshot({
  r2, observationsPrefix, dayUtc, connectorId, rows, getObject = r2GetObject,
}) {
  const prefix = observationsPrefix;
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  const rootBody = await readOptional(getObject, r2, rootKey);
  if (!rootBody) return { admission: "first_publication", previous_authority: null };
  const root = validateR2HistoryV2ObservationsAggregateManifest(parse(rootBody, rootKey), { basePrefix: prefix });
  if (root.kind !== "uk_aq_observations_root_manifest" ||
      !rootBody.equals(serializeR2HistoryV2ObservationsAggregateManifest(root, { basePrefix: prefix }))) {
    throw new Error(`Committed observation root identity disagrees: ${rootKey}`);
  }
  const year = Number(dayUtc.slice(0, 4));
  const month = dayUtc.slice(5, 7);
  const yearKey = buildR2HistoryV2ObservationsYearManifestKey(prefix, year);
  const yearRef = oneChild(root.children, "year", year, rootKey);
  if (!yearRef) return { admission: "first_publication", previous_authority: null };
  if (yearRef.manifest_key !== yearKey) throw new Error(`Committed observation year key disagrees: ${rootKey}`);
  const yearManifest = await aggregate(getObject, r2, prefix, yearKey, "uk_aq_observations_year_manifest");
  if (yearManifest.year !== year || yearManifest.content_hash !== yearRef.content_hash) throw new Error(`Committed observation year identity disagrees: ${yearKey}`);
  const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(prefix, year, month);
  const monthRef = oneChild(yearManifest.children, "month", month, yearKey);
  if (!monthRef) return { admission: "first_publication", previous_authority: null };
  if (monthRef.manifest_key !== monthKey) throw new Error(`Committed observation month key disagrees: ${yearKey}`);
  const monthManifest = await aggregate(getObject, r2, prefix, monthKey, "uk_aq_observations_month_manifest");
  if (monthManifest.year !== year || monthManifest.month !== month || monthManifest.content_hash !== monthRef.content_hash) throw new Error(`Committed observation month identity disagrees: ${monthKey}`);
  const dayKey = buildHistoryV2DayManifestKey(prefix, dayUtc);
  const dayRef = oneChild(monthManifest.children, "day_utc", dayUtc, monthKey);
  if (!dayRef) return { admission: "first_publication", previous_authority: null };
  if (dayRef.manifest_key !== dayKey) throw new Error(`Committed observation day key disagrees: ${monthKey}`);
  const day = await manifest(getObject, r2, dayKey, { manifest_kind: "day", day_utc: dayUtc }, dayRef.manifest_hash);
  const connectors = matchingReferences(day, "connector_manifests", "child_manifests", "connector_id", dayKey);
  const connectorRef = oneChild(connectors, "connector_id", connectorId, dayKey);
  if (!connectorRef) return { admission: "first_publication", previous_authority: null };
  const connectorKey = buildHistoryV2ConnectorManifestKey(prefix, dayUtc, connectorId);
  if (connectorRef.manifest_key !== connectorKey) throw new Error(`Committed observation connector key disagrees: ${dayKey}`);
  const authority = `${connectorKey}#${connectorRef.manifest_hash}`;
  const block = (reason) => { throw new PruneCommittedHistoryGuardError({ dayUtc, connectorId, previousAuthority: authority, reason }); };
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
    if (children.length !== byCode.size) block("frozen pollutant child set differs from committed history");
    for (const child of children) {
      const code = child.pollutant_code;
      const partition = byCode.get(code);
      if (!partition) block(`frozen source omits committed pollutant=${code}`);
      const childKey = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, code);
      if (child.manifest_key !== childKey) block(`committed pollutant key disagrees for pollutant=${code}`);
      const pollutant = await manifest(getObject, r2, childKey, { manifest_kind: "pollutant", day_utc: dayUtc, connector_id: connectorId, pollutant_code: code }, child.manifest_hash);
      validateObservationContentHashMetadata(pollutant, { rowCount: pollutant.row_count });
      if (pollutant.observation_content_hash_contract_version !== 1 ||
          pollutant.observation_content_hash !== computeObservationContentHash(partition).observation_content_hash ||
          pollutant.observation_content_hash_row_count !== partition.length) {
        block(`frozen observations differ from committed pollutant=${code}`);
      }
    }
  } catch (error) {
    if (error instanceof PruneCommittedHistoryGuardError) throw error;
    block(`complete replacement authority cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { admission: "identical_committed_content_retry", previous_authority: authority };
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
    });
  }
}
