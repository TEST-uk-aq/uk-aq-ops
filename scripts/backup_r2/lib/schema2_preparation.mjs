// Stage 2K: a run-local preparation record. This module has no R2 adapter,
// publication scheduler, lock acquisition, mutation or recovery entry point.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { getObservationHistoryGeneration, assertObservationHistoryGenerationKey } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { encodeObservationHistoryIndexV3Json as canonical, buildObservationHistoryExactLeafIndexV3Latest } from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { EXACT_LEAF_FORMATS_V3 } from "../../../workers/shared/uk_aq_observation_history_exact_leaf_format_v3.mjs";
import { prepareOfflineExactV3Reconstruction, authenticateExactV3CompactLatest } from "../uk_aq_plan_sos_light_v3_observation_metadata.mjs";
import { isChangedCurrentRunObject } from "../uk_aq_execute_v2_observations_repair_impl.mjs";
import { loadImmutableSourcePartition } from "../uk_aq_apply_integrity_proposal.mjs";
import { materializeSosLightV3ProposalBodies, SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT } from "./sos_light_v3_proposal_transport.mjs";
import { SCHEMA2_PREPARATION_LIMITS as LIMITS, assertPreparationResourceTotals, assertPreparationRuntimeCapacity, assertBoundedPreparationJson, preflightPhysicalBody } from "./schema2_preparation_resources.mjs";

export const SCHEMA2_PREPARATION_V1 = "uk_aq_integrity_v3_schema2_preparation_v1";
export const SCHEMA2_PREPARATION_FREEZE_V1 = "uk_aq_integrity_v3_schema2_preparation_freeze_v1";
export const SCHEMA2_PREPARATION_FINGERPRINT_V1 = "uk_aq_integrity_v3_schema2_preparation_fingerprint_v1";
const G = getObservationHistoryGeneration("v3");
const SHA = /^[a-f0-9]{64}$/;
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sorted = values => [...values].sort(order);
const same = (a, b) => canonical(a) === canonical(b);
const id = a => ({ key: a.key, byte_size: a.byte_size, sha256: a.sha256 });
const scopeId = s => `day_utc=${s.day_utc}/connector_id=${s.connector_id}/pollutant_code=${s.pollutant_code}`;
const parse = body => { assertBoundedPreparationJson(body); return JSON.parse(body.toString("utf8")); };

export class Schema2PreparationBlocked extends Error {
  constructor(code, detail, outcome = null) {
    super(`schema2 preparation blocked (${code}): ${detail}`);
    this.name = "Schema2PreparationBlocked";
    this.code = code;
    this.outcome = outcome;
    this.repair_apply_eligible = false;
    this.publication_eligible = false;
  }
}
function block(code, detail, outcome) { throw new Schema2PreparationBlocked(code, detail, outcome); }
function equal(a, b, label) { if (!same(a, b)) block("identity_mismatch", label); }
function count(value, max, label, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > max) block("capacity", label);
  return value;
}
function boundedJson(value, label) {
  const pending = [[value, 0]];
  let nodes = 0, minimumBytes = 0;
  while (pending.length) {
    const [current, depth] = pending.pop();
    if (++nodes > LIMITS.max_thrift_nodes || depth > LIMITS.max_thrift_depth) block("capacity", `${label} JSON complexity`);
    if (typeof current === "string") minimumBytes += Buffer.byteLength(current);
    else if (typeof current === "number" && !Number.isFinite(current)) block("contract", `${label} nonfinite JSON number`);
    else if (current && typeof current === "object") {
      const keys = Object.keys(current);
      if (keys.length + pending.length + nodes > LIMITS.max_thrift_nodes) block("capacity", `${label} JSON members`);
      for (const key of keys) { minimumBytes += Buffer.byteLength(key) + 3; pending.push([current[key], depth + 1]); }
    }
    if (minimumBytes > LIMITS.max_json_body_bytes) block("capacity", `${label} JSON bytes`);
  }
  const bytes = Buffer.byteLength(canonical(value));
  count(bytes, LIMITS.max_json_body_bytes, `${label} exceeds JSON bound`);
  return bytes;
}
function scope(value) {
  if (!value || Object.keys(value).sort().join() !== "connector_id,day_utc,pollutant_code" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.day_utc) || new Date(`${value.day_utc}T00:00:00Z`).toISOString().slice(0, 10) !== value.day_utc ||
      !Number.isSafeInteger(value.connector_id) || value.connector_id <= 0 || !/^[a-z0-9_]+$/.test(value.pollutant_code)) block("scope", "invalid explicit DCP");
  return { ...value };
}
function scopes(values, max, label) {
  if (!Array.isArray(values)) block("scope", label);
  count(values.length, max, label);
  const result = values.map(scope).sort((a, b) => order(scopeId(a), scopeId(b)));
  if (new Set(result.map(scopeId)).size !== result.length) block("scope", `duplicate ${label}`);
  return result;
}

// Reject every symlink component, including the root, before and after an
// O_NOFOLLOW open. fstat and post-read identity checks pin the actual descriptor.
function securePath(root, relative, expectedSize = null) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split("/").some(p => !p || p === "." || p === ".." || /[\\\x00-\x1f\x7f]/.test(p))) block("local_path", "unsafe local body reference");
  const absoluteRoot = path.resolve(root), target = path.join(absoluteRoot, ...relative.split("/"));
  let current = path.parse(target).root;
  const parts = target.slice(current.length).split(path.sep);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) block("local_path", `symlink or invalid path: ${relative}`);
  }
  const stat = fs.statSync(target);
  if (expectedSize !== null && stat.size !== expectedSize) block("local_identity", `local size changed: ${relative}`);
  return { target, stat };
}
function readBody(root, entry, cap = LIMITS.max_json_body_bytes) {
  count(entry.byte_size, cap, `body size: ${entry.key}`);
  if (!SHA.test(entry.sha256)) block("local_identity", `missing SHA: ${entry.key}`);
  const before = securePath(root, entry.relative_path, entry.byte_size);
  const fd = fs.openSync(before.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== before.stat.dev || st.ino !== before.stat.ino || st.size !== entry.byte_size) block("local_identity", entry.key);
    const body = Buffer.alloc(entry.byte_size);
    let offset = 0;
    while (offset < body.length) {
      const n = fs.readSync(fd, body, offset, body.length - offset, offset);
      if (!n) block("local_identity", `short read: ${entry.key}`);
      offset += n;
    }
    const after = fs.fstatSync(fd), again = securePath(root, entry.relative_path, entry.byte_size).stat;
    if (st.dev !== again.dev || st.ino !== again.ino || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs || sha256Hex(body) !== entry.sha256) block("local_identity", `changed body: ${entry.key}`);
    return body;
  } finally { fs.closeSync(fd); }
}
function inputEntries(values, source, runRoot) {
  if (!Array.isArray(values)) block("inventory", `${source} inventory required`);
  count(values.length, LIMITS.max_objects, `${source} objects`, true);
  const result = values.map(e => {
    if (!e || Object.keys(e).sort().join() !== "byte_size,key,relative_path,sha256") block("inventory", "input descriptor fields");
    if (e.key === G.observations_timeseries_latest_key && source === "dropbox") { /* checkpoint object */ }
    else assertObservationHistoryGenerationKey(G, e.key);
    count(e.byte_size, e.key.endsWith(".parquet") ? LIMITS.max_file_bytes : LIMITS.max_json_body_bytes, `${source} object bytes`);
    if (!SHA.test(e.sha256)) block("inventory", "input SHA");
    securePath(runRoot, e.relative_path, e.byte_size);
    return { ...e, source };
  }).sort((a, b) => order(a.key, b.key));
  if (new Set(result.map(e => e.key)).size !== result.length) block("inventory", `duplicate ${source} key`);
  return result;
}
function authority(runState) {
  if (runState?.history_generation !== "v3" || !["generic_integrity", "sos_light"].includes(runState.execution_path) || typeof runState.run_id !== "string" || !runState.run_id.trim()) block("authority", "run/mode/generation missing");
  if (runState.dropbox_currentness?.allowed !== true || runState.dropbox_currentness?.checkpoint_live_root_match !== true ||
      !SHA.test(runState.dropbox_currentness?.checkpoint?.observations_processed_source_root_hash)) block("authority", "accepted complete checkpoint/root equality missing");
  const context = runState.observations_global_operation_lock;
  if (context?.owner !== "integrity" || context?.run_id !== runState.run_id) block("authority", "original run/owner context missing (not a lock assertion)");
  const original = { run_id: runState.run_id, execution_path: runState.execution_path, history_generation: "v3",
    dropbox_currentness: runState.dropbox_currentness, observations_global_operation_lock: context,
    source_evidence_partitions: runState.source_evidence_partitions || {}, objects: runState.objects || {},
    tombstones: runState.tombstones || {}, tombstone_prefixes: runState.tombstone_prefixes || [] };
  boundedJson(original, "accepted input authority");
  const result = structuredClone(original);
  boundedJson(result, "accepted input authority");
  return result;
}

async function construct(request) {
  assertPreparationRuntimeCapacity();
  const { runState, runRoot } = request;
  const accepted = authority(runState);
  const affected = scopes(request.scopes, LIMITS.max_affected_dcps, "affected DCPs");
  if (accepted.execution_path === "sos_light" && affected.some(s => s.connector_id !== 1)) block("scope", "SOS-light repair ownership is connector 1 only");
  const baseline = inputEntries(request.baselineObjects, "dropbox", runRoot);
  const overlay = inputEntries(request.overlayObjects || [], "planned_overlay", runRoot);
  const allInputs = [...baseline, ...overlay];
  count(allInputs.length, LIMITS.max_objects, "whole input objects");
  const inputBytes = allInputs.reduce((n, e) => n + e.byte_size, 0);
  count(inputBytes, LIMITS.max_total_body_bytes, "whole input bytes");
  const baseMap = new Map(baseline.map(e => [e.key, e])), overlayMap = new Map(overlay.map(e => [e.key, e]));
  // Original paths are bound to the accepted unmasked backup root; replacement
  // paths must be exactly the current-run staged paths, not baseline substitutes.
  if (!runState.base_dropbox_root || !runState.overlay_root) block("authority", "accepted baseline/overlay roots required");
  for (const e of baseline) if (path.resolve(runRoot, e.relative_path) !== path.resolve(runState.base_dropbox_root, e.key)) block("provenance", `not original backup path: ${e.key}`);
  for (const e of overlay) {
    const staged = accepted.objects[e.key];
    if (!isChangedCurrentRunObject(staged) || staged.built !== true || staged.bytes !== e.byte_size || (staged.sha256 || staged.content_sha256) !== e.sha256 ||
        path.resolve(staged.local_path || "") !== path.resolve(runRoot, e.relative_path)) block("provenance", `not pinned current-run replacement: ${e.key}`);
  }
  for (const [key, staged] of Object.entries(accepted.objects)) if (isChangedCurrentRunObject(staged) && !overlayMap.has(key)) block("inventory", `unrepresented changed object: ${key}`);
  const read = e => {
    const body = readBody(runRoot, e, e.key.endsWith(".parquet") ? LIMITS.max_file_bytes : LIMITS.max_json_body_bytes);
    if (!e.key.endsWith(".parquet")) assertBoundedPreparationJson(body);
    return body;
  };
  const baseStore = { getObjectFromSourceIfExists(key, source) {
    if (source !== "dropbox") block("provenance", key);
    const e = baseMap.get(key); return e ? { key, body: read(e), source: "dropbox" } : null;
  } };
  const overlayStore = { getObjectFromSourceIfExists(key, source) {
    if (source !== "overlay") block("provenance", key);
    const e = overlayMap.get(key); return e ? { key, body: read(e), source: "planned_overlay" } : null;
  } };
  const registry = authenticateExactV3CompactLatest({ runState: accepted, store: baseStore });
  count(registry.roots.length, LIMITS.max_scopes, "complete selected registry");
  const knownScopes = registry.roots.map(r => scope({ day_utc: r.day_utc, connector_id: r.connector_id, pollutant_code: r.pollutant_code }));
  const scopeSet = new Set(knownScopes.map(scopeId)), affectedSet = new Set(affected.map(scopeId));
  const wholeScopes = [...new Map([...knownScopes, ...affected].map(s => [scopeId(s), s])).values()];
  count(wholeScopes.length, LIMITS.max_scopes, "whole operation scopes");
  const allowedOverlayKeys = new Set([G.observations_root_key]);
  for (const s of affected) {
    allowedOverlayKeys.add(`${G.observations_prefix}/_manifests/year=${s.day_utc.slice(0, 4)}/manifest.json`);
    allowedOverlayKeys.add(`${G.observations_prefix}/_manifests/year=${s.day_utc.slice(0, 4)}/month=${s.day_utc.slice(5, 7)}/manifest.json`);
    allowedOverlayKeys.add(`${G.observations_prefix}/day_utc=${s.day_utc}/manifest.json`);
    allowedOverlayKeys.add(`${G.observations_prefix}/day_utc=${s.day_utc}/connector_id=${s.connector_id}/manifest.json`);
  }
  for (const e of overlay) if (!allowedOverlayKeys.has(e.key) && !affected.some(s => e.key.startsWith(`${G.observations_prefix}/${scopeId(s)}/`))) block("scope", `changed object outside affected ancestors: ${e.key}`);
  const absent = affected.filter(s => !scopeSet.has(scopeId(s)));
  // Full whole-checkpoint closure is intentional for v1. We do not accept a
  // sparse graph and claim that uninspected external children were checked.
  const versions = new Map(registry.roots.map(r => [scopeId(r), r.exact_index_schema_version === 2 ? 2 : 1]));
  const selectedDays = sorted(new Set(affected.map(s => s.day_utc)));
  if (accepted.execution_path === "sos_light" && (!Array.isArray(request.selectedDays) || !same(sorted(request.selectedDays), selectedDays) || new Set(request.selectedDays).size !== request.selectedDays.length)) block("scope", "SOS-light requires exact complete selected-day set");
  const usedBase = new Set([G.observations_timeseries_latest_key]), usedOverlay = new Set();
  const manifests = { baseline: new Map(), proposed: new Map() }, files = { baseline: new Map(), proposed: new Map() };
  let edges = 0;
  function walk(key, proposed, seen) {
    if (seen.has(key)) block("graph", `duplicate/cyclic canonical membership: ${key}`);
    seen.add(key);
    const e = (proposed && overlayMap.get(key)) || baseMap.get(key);
    if (!e) block("closure", `canonical body missing: ${key}`, "blocked_empty_or_removal");
    (e.source === "dropbox" ? usedBase : usedOverlay).add(key);
    const payload = parse(read(e));
    const variant = proposed ? "proposed" : "baseline";
    manifests[variant].set(key, { entry: e, payload });
    const children = key.includes("/_manifests/") ? payload.children : payload.child_manifests;
    if (!Array.isArray(children)) block("closure", `canonical child array missing: ${key}`);
    edges += children.length;
    count(edges, LIMITS.max_edges, "canonical dependency edges", true);
    for (const child of children) {
      assertObservationHistoryGenerationKey(G, child.manifest_key);
      walk(child.manifest_key, proposed, seen);
    }
    if (payload.manifest_kind === "pollutant") {
      const s = scope({ day_utc: payload.day_utc, connector_id: payload.connector_id, pollutant_code: payload.pollutant_code });
      if (key !== `${G.observations_prefix}/${scopeId(s)}/manifest.json` || !scopeSet.has(scopeId(s))) block("closure", `canonical/selector membership differs: ${key}`);
      if (payload.history_schema_version !== 3 || payload.writer_version !== "parquet-wasm-zstd-v3") block("unsupported_physical_schema", key);
      if (!Array.isArray(payload.files) || !payload.files.length || payload.row_count <= 0) block("empty_or_removal", key, "blocked_empty_or_removal");
      count(payload.row_count, LIMITS.max_decoded_rows, "DCP decoded rows");
      for (const f of payload.files) {
        const d = (proposed && overlayMap.get(f.key)) || baseMap.get(f.key);
        if (!d || d.byte_size !== f.bytes || d.sha256 !== f.etag_or_hash || files[variant].has(f.key)) block("closure", `physical identity/membership: ${f.key}`);
        count(f.row_count, LIMITS.max_file_rows, "physical rows");
        files[variant].set(f.key, { entry: d, row_count: f.row_count });
        (d.source === "dropbox" ? usedBase : usedOverlay).add(f.key);
      }
      edges += payload.files.length;
    }
    count(seen.size, LIMITS.max_objects, "canonical graph objects");
    return payload;
  }
  walk(G.observations_root_key, false, new Set());
  walk(G.observations_root_key, true, new Set());
  const catalogued = map => sorted([...map.values()].filter(m => m.payload.manifest_kind === "pollutant").map(m => scopeId(m.payload)));
  equal(catalogued(manifests.baseline), sorted(scopeSet), "complete original canonical/selector membership");
  if (!same(catalogued(manifests.proposed), sorted(scopeSet))) block("empty_or_removal", "empty/removal/new canonical membership unsupported", "blocked_empty_or_removal");
  for (const [key, { entry, payload }] of manifests.proposed) {
    if (payload.manifest_kind === "pollutant" && entry.source === "planned_overlay" && !affectedSet.has(scopeId(payload))) block("scope", `changed out-of-scope DCP: ${key}`);
  }
  if (usedBase.size !== baseline.length || usedOverlay.size !== overlay.length) block("inventory", "extra input object membership");
  // Bound rows, prospective exact/aligned object/edge counts and serialization
  // BEFORE reconstructing indexes or decoding any Parquet. 16 KiB per row plus
  // 4 KiB per derived object deliberately over-admits neither large fan-out nor
  // repeated segment/file metadata. Actual totals are checked again afterwards.
  const uniqueFiles = new Map([...files.baseline.values(), ...files.proposed.values()].map(f => [`${f.entry.sha256}:${f.entry.key}`, f]));
  const rows = [...uniqueFiles.values()].reduce((n, f) => n + f.row_count, 0);
  count(rows, LIMITS.max_decoded_rows, "whole-graph decoded rows");
  let derivedObjects = 1, seriesTotal = 0;
  for (const { payload } of manifests.proposed.values()) if (payload.manifest_kind === "pollutant") {
    const series = Object.keys(payload.timeseries_row_counts || {}).length;
    count(series, LIMITS.max_objects, "series membership"); seriesTotal += series;
    derivedObjects += versions.get(scopeId(payload)) === 1 ? 2 * series + 2 : series + 1;
  }
  let upper = { affected_dcps: affected.length, scopes: wholeScopes.length, objects: allInputs.length * 2 + derivedObjects, edges: edges + derivedObjects * (uniqueFiles.size + 2),
    total_body_bytes: 2 * inputBytes + rows * 16384 + derivedObjects * 4096,
    decoded_rows: rows, uncompressed_bytes: LIMITS.max_uncompressed_bytes };
  assertPreparationResourceTotals(upper);
  const physical = [];
  for (const f of [...uniqueFiles.values()].sort((a, b) => order(a.entry.key + a.entry.sha256, b.entry.key + b.entry.sha256))) physical.push({ key: f.entry.key, sha256: f.entry.sha256,
    ...preflightPhysicalBody(read(f.entry), { row_count: f.row_count }) });
  const uncompressed = physical.reduce((n, f) => n + f.uncompressed_bytes, 0);
  count(uncompressed, LIMITS.max_uncompressed_bytes, "whole-graph uncompressed pages", true);
  // Pin source files before the existing immutable-source loader can read them.
  const sourcePins = [];
  for (const [identity, source] of Object.entries(accepted.source_evidence_partitions)) {
    if (!affectedSet.has(identity)) block("scope", `extra immutable source partition: ${identity}`);
    for (const [field, digest] of [["evidence_path", "evidence_sha256"], ["rows_path", "rows_sha256"]]) {
      const filename = source[field], relative = path.relative(path.resolve(runRoot), path.resolve(filename || "")).split(path.sep).join("/");
      const stat = securePath(runRoot, relative).stat;
      const e = { key: `${identity}/${field}`, relative_path: relative, byte_size: stat.size, sha256: source[digest], source: "immutable_source" };
      sourcePins.push(e);
    }
  }
  let sourceBytes = sourcePins.reduce((n, e) => n + e.byte_size, 0);
  count(inputBytes + sourceBytes, LIMITS.max_total_body_bytes, "input and source bytes");
  assertPreparationResourceTotals({ ...upper, objects: upper.objects + sourcePins.length, total_body_bytes: upper.total_body_bytes + sourceBytes });
  const sourcePaths = new Map(sourcePins.map(e => [path.resolve(runRoot, e.relative_path), e]));
  const readSourceBody = filename => {
    const pin = sourcePaths.get(path.resolve(filename));
    if (!pin) block("source", "unadmitted immutable source path");
    const body = readBody(runRoot, pin); assertBoundedPreparationJson(body); return body;
  };
  let sourceRows = 0;
  for (const e of sourcePins.filter(e => e.key.endsWith("/evidence_path"))) {
    const evidence = parse(readSourceBody(path.resolve(runRoot, e.relative_path)));
    sourceRows += count(evidence.total_rows, LIMITS.max_decoded_rows, "immutable source rows", true);
    if (evidence.semantic_evidence_contract === "official_rdata_semantic_evidence") {
      const identity = e.key.slice(0, -"/evidence_path".length), source = accepted.source_evidence_partitions[identity];
      const filename = path.join(path.dirname(source.rows_path), "preserved_baseline_rows.json");
      const relative_path = path.relative(path.resolve(runRoot), filename).split(path.sep).join("/");
      const pin = { key: `${identity}/preserved_baseline_rows_path`, relative_path, byte_size: evidence.preserved_baseline_rows_bytes,
        sha256: evidence.preserved_baseline_rows_sha256, source: "immutable_source" };
      count(pin.byte_size, LIMITS.max_json_body_bytes, "preserved source bytes");
      securePath(runRoot, relative_path, pin.byte_size);
      sourceRows += count(evidence.preserved_baseline_row_count, LIMITS.max_decoded_rows, "preserved source rows", true);
      sourceBytes += pin.byte_size;
      sourcePins.push(pin); sourcePaths.set(path.resolve(filename), pin);
      if (!evidence.final_target_row_count) block("empty_or_removal", e.key, "blocked_empty_or_removal");
    } else if (!evidence.total_rows) block("empty_or_removal", e.key, "blocked_empty_or_removal");
  }
  count(rows + sourceRows, LIMITS.max_decoded_rows, "physical and source decoded rows");
  upper = { ...upper, decoded_rows: rows + sourceRows, objects: upper.objects + sourcePins.length, total_body_bytes: upper.total_body_bytes + sourceBytes };
  assertPreparationResourceTotals(upper);
  const state = { ...accepted, overlay_root: runState.overlay_root };
  // Even unchanged source records supplied to this boundary are independently
  // authenticated. Preservation does not grant a replacement right.
  for (const s of affected.filter(s => accepted.source_evidence_partitions[scopeId(s)])) {
    const source = loadImmutableSourcePartition({ runState: state, dayUtc: s.day_utc, connectorId: s.connector_id, pollutantCode: s.pollutant_code, readSourceBody });
    const manifest = manifests.proposed.get(`${G.observations_prefix}/${scopeId(s)}/manifest.json`)?.payload;
    if (!manifest) block("empty_or_removal", scopeId(s), "blocked_empty_or_removal");
    equal(Object.fromEntries(Object.keys(source.finalTargetMetadata).map(k => [k, manifest[k]])), source.finalTargetMetadata, `final source target: ${scopeId(s)}`);
  }
  const hasRemovals = Object.values(accepted.tombstones).some(e => e?.proposed === true || e?.deleted === true) || accepted.tombstone_prefixes.some(e => e?.proposed === true);
  const reconstructed = await prepareOfflineExactV3Reconstruction({ runState: state, baselineStore: baseStore, scopes: knownScopes,
    repairOverlay: overlay.length || hasRemovals ? { store: overlayStore } : null, readSourceBody });
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: reconstructed.scopes.map(s => s.hierarchy) });
  const nodes = new Map(), graphEdges = [];
  function node(artifact, type, provenance) {
    const value = { preparation_contract_version: SCHEMA2_PREPARATION_V1, ...id(artifact), type, provenance };
    const old = nodes.get(value.key);
    if (old) { equal(old, value, `conflicting graph key ${value.key}`); return; }
    nodes.set(value.key, value);
  }
  function edge(from, to, type) {
    if (!nodes.has(to)) block("closure", `missing graph dependency: ${to}`);
    graphEdges.push({ from, to, type });
  }
  const bodies = new Map();
  for (const { entry } of manifests.proposed.values()) { node(entry, "canonical_manifest", entry.source); bodies.set(entry.key, read(entry)); }
  for (const { entry } of files.proposed.values()) { node(entry, "canonical_parquet", entry.source); bodies.set(entry.key, read(entry)); }
  for (const [key, { payload }] of manifests.proposed) {
    for (const c of (key.includes("/_manifests/") ? payload.children : payload.child_manifests)) edge(key, c.manifest_key, "canonical_child");
    if (payload.manifest_kind === "pollutant") for (const f of payload.files) edge(key, f.key, "physical_file");
  }
  const artifacts = [...reconstructed.scopes.flatMap(s => s.hierarchy.publication_objects), latest];
  for (const a of artifacts) { node(a, a.kind, "deterministic_local_index"); bodies.set(a.key, Buffer.from(a.body)); }
  for (const a of artifacts) for (const d of [...a.dependencies, ...a.publication_prerequisites]) {
    const target = nodes.get(d.key); if (!target) block("closure", `missing index dependency: ${d.key}`);
    equal(id(target), id(d), `index dependency identity: ${d.key}`);
    edge(a.key, d.key, "index_dependency");
  }
  const dedupEdges = [...new Map(graphEdges.map(e => [canonical(e), e])).values()].sort((a, b) => order(canonical(a), canonical(b)));
  const outcomes = reconstructed.scopes.map(s => {
    const prior = registry.roots.find(r => scopeId(r) === scopeId(s.scope));
    const priorFormat = EXACT_LEAF_FORMATS_V3.find(f => f.schema_version === versions.get(scopeId(s.scope)));
    if (!affectedSet.has(scopeId(s.scope)) && !s.prepared_matches_checkpoint_selection) block("scope", `retained selector changed: ${scopeId(s.scope)}`);
    return { scope: s.scope, affected: affectedSet.has(scopeId(s.scope)), outcome: s.source_changed ? "complete_nonempty_replacement" : "unchanged_or_preserved",
      prior: { ...id(s.checkpoint_selected_selector), schema_version: priorFormat.schema_version, kind: priorFormat.manifest_kind, exact_leaf_index_version: priorFormat.exact_leaf_index_version, checkpoint_descriptor: prior },
      proposed: { ...id(s.prepared_selector), schema_version: s.hierarchy.scoped_manifest.payload.schema_version, kind: s.hierarchy.scoped_manifest.payload.kind, exact_leaf_index_version: s.hierarchy.scoped_manifest.payload.exact_leaf_index_version },
      baseline_canonical_source: s.baseline_canonical_source, proposed_canonical_source: s.canonical_source_manifest,
      canonical_chain: s.canonical_chain, source_evidence: s.source_evidence, inspector: s.inspector };
  });
  for (const s of absent) {
    if (overlay.some(e => e.key.includes(`/${scopeId(s)}/`)) || accepted.source_evidence_partitions[scopeId(s)]) block("empty_or_removal", scopeId(s), "blocked_empty_or_removal");
    outcomes.push({ scope: s, affected: true, outcome: "proved_absent_noop", prior: { no_selector: true, proof: "complete_checkpoint_canonical_and_registry_absence" }, proposed: { no_selector: true }, source_evidence: null });
  }
  const inventory = [...nodes.values()].sort((a, b) => order(a.key, b.key));
  const stagedBytes = inventory.reduce((n, e) => n + e.byte_size, 0);
  const totals = assertPreparationResourceTotals({ affected_dcps: affected.length, scopes: wholeScopes.length, objects: allInputs.length + inventory.length + sourcePins.length,
    edges: dedupEdges.length, total_body_bytes: inputBytes + sourceBytes + stagedBytes, decoded_rows: rows + sourceRows, uncompressed_bytes: uncompressed });
  for (const e of allInputs) read(e);
  for (const e of sourcePins) readBody(runRoot, e);
  return { projection: { contract_version: SCHEMA2_PREPARATION_V1, state: "prepared_only", run_id: accepted.run_id, owner: "integrity", execution_path: accepted.execution_path,
    history_generation: "v3", repair_apply_eligible: false, publication_eligible: false, read_only: true,
    current_object_authority: null, conditional_publication_authority: null, complete_preparation: true,
    accepted_authority: accepted, operation_scope: affected, selected_days: accepted.execution_path === "sos_light" ? selectedDays : [],
    closure_policy: "complete_checkpoint_canonical_and_selected_index_graph_v1", input_inventory: allInputs, immutable_source_inventory: sourcePins,
    outcomes: outcomes.sort((a, b) => order(scopeId(a.scope), scopeId(b.scope))), inventory, edges: dedupEdges,
    limits: LIMITS, admission_upper_bounds: upper, observed_totals: totals, physical_evidence: physical }, bodies };
}

function freeze(projection) {
  const canonical_json = canonical(projection), byte_size = Buffer.byteLength(canonical_json), sha256 = sha256Hex(canonical_json);
  count(byte_size, LIMITS.max_json_body_bytes, "preparation freeze bytes");
  return { ...projection, freeze: { contract_version: SCHEMA2_PREPARATION_FREEZE_V1, canonical_json, byte_size, sha256 },
    fingerprint: { contract_version: SCHEMA2_PREPARATION_FINGERPRINT_V1, sha256 } };
}
function bodyDirectory(request) {
  const relative = `schema2-preparation/${request.runState.run_id}`;
  // The retained coordinator uses integrity:TEST:<timestamp>. A colon is a
  // safe POSIX filename character; separators and traversal remain forbidden.
  if (!/^[a-zA-Z0-9_:-]+$/.test(request.runState.run_id)) block("authority", "unsafe run ID");
  const target = path.resolve(request.runRoot, relative);
  // Validate every existing ancestor before creating one missing component.
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) fs.mkdirSync(current, { mode: 0o700 });
    const st = fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink()) block("local_path", "preparation body directory");
  }
  return { target, relative };
}
function withReferences(projection, directoryRelative) {
  return { ...projection, inventory: projection.inventory.map(e => ({ ...e, body_ref: {
    contract_version: SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT, source: "planned_overlay", relative_path: `${directoryRelative}/${e.key}`, sha256: e.sha256, bytes: e.byte_size } })) };
}

export async function prepareSchema2PreparationV1(request) {
  if (Object.hasOwn(request.runState || {}, "schema2_preparation")) block("authority", "preparation already retained; no implicit replacement/recovery");
  const { projection, bodies } = await construct(request);
  const directory = bodyDirectory(request);
  // The carrier receives an isolated scratch object, never executable runState
  // or its planning.proposals. Only private references survive in the sidecar.
  const scratch = { planning: { proposals: projection.inventory.map(e => ({ key: e.key, bytes: e.byte_size, new_sha256: e.sha256, changed: true, proposed_body: bodies.get(e.key) })) } };
  for (const e of projection.inventory) {
    const target = path.join(directory.target, e.key);
    if (fs.existsSync(target)) readBody(request.runRoot, { ...e, relative_path: `${directory.relative}/${e.key}` }, e.type === "canonical_parquet" ? LIMITS.max_file_bytes : LIMITS.max_json_body_bytes);
    // Reject pre-existing symlink parent components before carrier writes.
    let p = directory.target;
    for (const part of e.key.split("/").slice(0, -1)) { p = path.join(p, part); const st = fs.lstatSync(p, { throwIfNoEntry: false }); if (st && (!st.isDirectory() || st.isSymbolicLink())) block("local_path", e.key); }
  }
  materializeSosLightV3ProposalBodies({ output: scratch, overlayRoot: directory.target, runState: { objects: {} } });
  const preparation = freeze(withReferences(projection, directory.relative));
  await validateSchema2PreparationV1({ ...request, preparation });
  request.runState.schema2_preparation = preparation;
  return preparation;
}

// Independently re-opens all original, source, repair and staged bytes; rebuilds
// physical/index/canonical proof from the caller's accepted inputs. A sidecar
// cannot supply its own checkpoint or replace those trusted admission inputs.
export async function validateSchema2PreparationV1(request) {
  assertPreparationRuntimeCapacity();
  const preparation = request.preparation || request.runState?.schema2_preparation;
  if (!preparation || preparation.contract_version !== SCHEMA2_PREPARATION_V1) block("contract", "preparation v1 required");
  boundedJson(preparation, "sidecar");
  const { freeze: suppliedFreeze, fingerprint, ...projection } = preparation;
  equal(freeze(projection), preparation, "strict canonical freeze/fingerprint");
  const { projection: rebuilt } = await construct(request);
  const directoryRelative = `schema2-preparation/${request.runState.run_id}`;
  equal(withReferences(rebuilt, directoryRelative), projection, "independent complete graph/provenance/physical validation");
  for (const e of preparation.inventory) readBody(request.runRoot, { ...e, relative_path: e.body_ref.relative_path }, e.type === "canonical_parquet" ? LIMITS.max_file_bytes : LIMITS.max_json_body_bytes);
  return { valid: true, complete_preparation: true, contract_version: SCHEMA2_PREPARATION_V1,
    fingerprint: { ...fingerprint }, read_only: true, repair_apply_eligible: false, publication_eligible: false,
    current_object_authority: null, conditional_publication_authority: null };
}
