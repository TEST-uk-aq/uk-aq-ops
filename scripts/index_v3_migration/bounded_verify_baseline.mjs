import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeObservationHistoryV3MigrationTransition, preparedUnitFromRecord, buildCanonicalParents,
  buildObservationHistoryV3RecoveryReplayStateSha256,
} from '../backup_r2/lib/observation_history_migration_v3.mjs';
import { validateCleanStartEvidence, GCP_CLEAN_POLICY } from '../backup_r2/lib/observation_history_migration_gcp.mjs';
import { validateRecoveryUpdateStructure } from '../backup_r2/uk_aq_observation_history_migration_v3.mjs';
import { createEvidenceRelocation } from './evidence_relocation.mjs';
import { authenticateCutoverVerifierDependencies } from './index_v3_cutover_generation_evidence.mjs';
import { authenticateExceptionalRecovery, EXCEPTIONAL_LIVE_RECOVERY } from './exceptional_recovery_authority.mjs';
import { authenticateDiskJournal, envelope } from './bounded_verify_journal.mjs';
import { DiskPlan, demand, same, sha256, MiB, readJsonBounded } from './bounded_verify_store.mjs';
import { getObservationHistoryGeneration, assertObservationHistoryGenerationKey } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { buildObservationsManifestHierarchy } from '../backup_r2/uk_aq_observations_manifest_hierarchy.mjs';
import {
  scopedRootDescriptor, latestArtifactFromRoots, buildObservationHistoryIndexV3PublicationPlan,
  validateObservationHistoryExactLeafArtifactV3, validateObservationHistoryExactLeafScopedManifestArtifactV3,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
} from '../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';
import {
  canonicalObservationHistoryIndexV3JsonChunks, OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT,
} from '../../workers/shared/uk_aq_observation_history_index_v3.mjs';

const ranks = { canonical_parquet: 10, canonical_manifest: 20, child_shard: 30, scoped_manifest: 40, latest_global: 50 };
const compact = ({ key, byte_size, sha256: sha, kind }) => ({ key, byte_size, sha256: sha, ...(kind ? { kind } : {}) });
export function completionMatches(evidence, expected, parquet = false) {
  return evidence?.verified === true && evidence.durable === true && evidence.byte_size === expected.byte_size &&
    evidence.sha256 === expected.sha256 && (!parquet || evidence.stored_sha256_verified === true) &&
    (evidence.key === undefined || evidence.key === expected.key);
}

// Only bounded compact summaries may be accumulated (never leaves/completions).
function collectSmall(values, limit = 64 * MiB) {
  const result = []; let bytes = 0;
  for (const value of values) {
    bytes += Buffer.byteLength(JSON.stringify(value)) * 2;
    demand(bytes <= limit, 'Compact summary budget exceeded'); result.push(value);
  }
  return result;
}

export class BoundedBaseline {
  constructor(store, disk, checkpoint, plan) { Object.assign(this, { store, disk, checkpoint, plan }); }
  unit(ordinal, hierarchy = true) {
    const row = this.store.get('SELECT record,id FROM prepared WHERE ordinal=?', ordinal);
    demand(row, `Missing prepared scope ${ordinal}`);
    const authority = this.disk.value('units', String(ordinal));
    demand(authority.unit_id === row.id, 'Prepared order differs from immutable plan');
    const record = JSON.parse(row.record);
    // Bound expansion BEFORE invoking the existing deterministic scope builder.
    // A larger scope fails incomplete; it is never silently split or skipped.
    demand(row.record.length * 2 <= 64 * MiB && record.target_metadata?.segments?.length <= 32768 &&
      record.target_metadata?.files?.length <= 8192, 'Prepared scope exceeds bounded reconstruction limits');
    return preparedUnitFromRecord(authority, record, { sideBySide: true, includeV3Hierarchy: hierarchy });
  }
  addObject(entry, { v3 = false, external = 0, parquet = false } = {}) {
    const store = this.store;
    const descriptor = { ...compact(entry), publication_stage: entry.publication_stage || (parquet ? 'canonical_parquet' : 'canonical_manifest'),
      dependencies: entry.dependencies || [], publication_prerequisites: entry.publication_prerequisites || [] };
    demand(typeof entry.key === 'string' && /^[\x20-\x7e]+$/.test(entry.key) &&
      Number.isSafeInteger(entry.byte_size) && entry.byte_size > 0 && /^[0-9a-f]{64}$/.test(entry.sha256), 'Invalid expected dependency identity');
    const generation = getObservationHistoryGeneration(external === 2 ? 'v2' : 'v3');
    const domain = external === 2 || entry.key.startsWith(`${generation.timeseries_binding_index_prefix}/`) ? 'bindings'
      : v3 ? entry.key === generation.observations_timeseries_latest_key ? 'latest' : 'observation_index' : 'observations';
    assertObservationHistoryGenerationKey(generation, entry.key, domain);
    const old = store.get('SELECT * FROM objects WHERE key=?', entry.key);
    if (old) {
      demand(old.size === entry.byte_size && old.sha === entry.sha256 && old.v3 === Number(v3) && old.external === external,
        `Contradictory reconstructed object: ${entry.key}`);
      return;
    }
    if (external !== 2) {
      const completion = store.get('SELECT evidence FROM completed WHERE key=?', entry.key);
      demand(completion && completionMatches(JSON.parse(completion.evidence), entry, parquet),
        `Missing/exact completion or stored-SHA evidence: ${entry.key}`);
    }
    store.run('INSERT INTO objects(key,size,sha,stage,rank,v3,external,descriptor) VALUES(?,?,?,?,?,?,?,?)', entry.key,
      entry.byte_size, entry.sha256, descriptor.publication_stage, ranks[descriptor.publication_stage] || 20,
      Number(v3), external, JSON.stringify(descriptor));
    for (const [relation, references] of [['content', descriptor.dependencies], ['order', descriptor.publication_prerequisites]]) {
      for (const reference of references) store.run('INSERT INTO edges VALUES(?,?,?,?,?,?)',
        entry.key, reference.key, reference.byte_size, reference.sha256, relation, reference.kind || null);
    }
  }
  async buildDependencies() {
    const { store, disk, plan } = this;
    store.phase = 'reconstruct-scopes';
    // Each generated target is checked against authenticated completion evidence
    // immediately; none of these bodies survives the scope boundary.
    for (let ordinal = 0; ordinal < this.unitCount; ordinal++) {
      const unit = this.unit(ordinal);
      for (const artifact of unit.v3_hierarchy.child_shards) validateObservationHistoryExactLeafArtifactV3({ artifact });
      validateObservationHistoryExactLeafScopedManifestArtifactV3({ artifact: unit.v3_hierarchy.scoped_manifest,
        exactLeaves: unit.v3_hierarchy.child_shards });
      const record = JSON.parse(store.get('SELECT record FROM prepared WHERE ordinal=?', ordinal).record);
      demand(record.files_published === true, `Prepared unit not completely published: ${unit.unit_id}`);
      demand(same(record.scope, unit.scope) && record.v3_index_root === plan.v3_index_root &&
        record.target_manifest.writer_git_sha === plan.target_writer_git_sha, 'Prepared writer/scope differs');
      for (const intent of unit.target_file_intents) this.addObject({ ...intent, kind: 'canonical_parquet' }, { external: 1, parquet: true });
      this.addObject({ ...unit.target_manifest_object, kind: 'canonical_manifest' }, { external: 1 });
      const scopeSchedule = buildObservationHistoryIndexV3PublicationPlan({ objects: unit.v3_hierarchy.publication_objects,
        externalReferences: [...unit.target_file_intents.map((entry) => ({ ...compact(entry), kind: 'canonical_parquet', verified: true, durable: true })),
          { ...compact(unit.target_manifest_object), kind: 'canonical_manifest', verified: true, durable: true }] });
      for (const entry of scopeSchedule.entries) this.addObject(entry, { v3: true });
      store.summary('root', unit.v3_hierarchy.scoped_manifest.key, scopedRootDescriptor(unit.v3_hierarchy.scoped_manifest));
      store.summary('unit-manifest', `${unit.scope.day_utc}|${unit.unit_id}`, {
        scope: unit.scope, target_manifest: unit.target_manifest,
        target_manifest_object: compact(unit.target_manifest_object),
      });
      await store.boundary(true);
    }
    store.phase = 'reconstruct-canonical-parents';
    for (const value of disk.values('inventory', 'connector_manifests')) {
      store.summary('source-connector', `${value.day_utc}|${value.connector_id}`, value);
      await store.boundary();
    }
    for (const value of disk.values('inventory', 'empty_source_connectors')) {
      store.summary('empty-connector', `${value.scope.day_utc}|${value.scope.connector_id}`, value);
      await store.boundary();
    }
    let coveredUnits = 0, coveredConnectors = 0;
    // Build existing canonical parents one UTC day at a time with exactly the
    // existing builder and physical child JSON insertion order.
    for (const day of disk.values('inventory', 'day_manifests')) {
      const connectors = collectSmall(store.summariesPrefix('source-connector', `${day.day_utc}|`));
      const empty = collectSmall(store.summariesPrefix('empty-connector', `${day.day_utc}|`));
      const units = collectSmall(store.summariesPrefix('unit-manifest', `${day.day_utc}|`));
      coveredUnits += units.length; coveredConnectors += connectors.length;
      demand(connectors.length > 0, 'Source day has no connector authority');
      const parents = buildCanonicalParents({ inventory: { connector_manifests: connectors,
        day_manifests: [day], empty_source_connectors: empty }, units,
      observationsPrefix: plan.target_observations_prefix, targetWriterGitSha: plan.target_writer_git_sha });
      for (const entry of [...parents.connector_objects, ...parents.day_objects]) this.addObject(entry);
      demand(parents.day_objects.length === 1, 'Canonical day coverage differs');
      const payload = parents.day_objects[0].payload;
      // The aggregate builder consumes ONLY these three fields. Retaining all
      // day-manifest file arrays here would re-materialise the whole archive.
      store.summary('canonical-day', day.day_utc, { day_utc: payload.day_utc,
        manifest_key: payload.manifest_key, manifest_hash: payload.manifest_hash });
      await store.boundary(true);
    }
    demand(coveredUnits === this.unitCount && coveredConnectors === disk.length(disk.at('inventory', 'connector_manifests')),
      'Canonical parent hierarchy omits a source scope');
    const days = collectSmall(store.summaries('canonical-day'));
    const aggregate = buildObservationsManifestHierarchy({ observationsPrefix: plan.target_observations_prefix, dayManifests: days });
    for (const entry of aggregate.objects) {
      const bytes = Buffer.from(entry.body);
      const dependencies = entry.manifest.children.map((child) => {
        const object = store.get('SELECT key,size,sha FROM objects WHERE key=?', child.manifest_key);
        demand(object, `Missing canonical aggregate child: ${child.manifest_key}`);
        return { key: object.key, byte_size: object.size, sha256: object.sha,
          kind: entry.level === 'month' ? 'day_manifest' : entry.level === 'year' ? 'month_manifest' : 'year_manifest' };
      });
      this.addObject({ key: entry.key, byte_size: bytes.length, sha256: sha256(bytes), dependencies });
    }
    store.phase = 'reconstruct-global-index';
    // These are compact validated root descriptors, not the 1.3M publications.
    const roots = collectSmall(store.summaries('root'));
    roots.sort((a, b) => Buffer.compare(Buffer.from(a.day_utc), Buffer.from(b.day_utc)) ||
      a.connector_id - b.connector_id || Buffer.compare(Buffer.from(a.pollutant_code), Buffer.from(b.pollutant_code)));
    const latest = latestArtifactFromRoots(roots, plan.v3_index_root, plan.v3_latest_key);
    validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: latest, indexRoot: plan.v3_index_root, latestKey: plan.v3_latest_key });
    const latestSchedule = buildObservationHistoryIndexV3PublicationPlan({ objects: [latest], externalReferences:
      roots.map((entry) => ({ ...compact(entry), verified: true, durable: true, kind: 'scoped_manifest' })) });
    this.addObject(latestSchedule.entries[0], { v3: true });
    for (const entry of disk.values('bindings', 'source_objects')) { this.addObject(entry, { external: 2 }); await store.boundary(); }
    for (const entry of disk.values('bindings', 'bindings')) {
      store.run('INSERT INTO bindings VALUES(?,?,?)', entry.timeseries_id, entry.connector_id, entry.pollutant_code);
      this.addObject({ ...entry, key: entry.source_key }, { external: 2 });
      this.addObject(entry); await store.boundary();
    }
    for (const entry of disk.values('bindings', 'manifests')) { this.addObject(entry); await store.boundary(); }
    // An authenticated but unexplained completion can never be ignored.
    demand(!store.get('SELECT c.key FROM completed c LEFT JOIN objects o ON o.key=c.key WHERE o.key IS NULL OR o.external=2 LIMIT 1'),
      'Completed evidence contains an unexplained target');
    demand(!store.get(`SELECT e.parent FROM edges e LEFT JOIN objects o ON o.key=e.child
      WHERE o.key IS NULL OR o.size!=e.size OR o.sha!=e.sha LIMIT 1`), 'Dependency closure has a missing or contradictory identity');
    await this.scheduleAndAuthenticatePublications();
  }
  async scheduleAndAuthenticatePublications() {
    const store = this.store;
    store.phase = 'authenticate-publication-schedule';
    store.run(`UPDATE objects SET indegree=(SELECT COUNT(*) FROM edges e JOIN objects child ON child.key=e.child
      WHERE e.parent=objects.key AND child.v3=1) WHERE v3=1`);
    let position = 0;
    for (;;) {
      const next = store.get('SELECT key FROM objects WHERE v3=1 AND indegree=0 AND position IS NULL ORDER BY rank,key COLLATE BINARY LIMIT 1');
      if (!next) break;
      store.run('UPDATE objects SET position=? WHERE key=?', ++position, next.key);
      // Multiple relationship types are distinct graph edges, as in the existing scheduler.
      store.run(`UPDATE objects SET indegree=indegree-(SELECT COUNT(*) FROM edges e WHERE e.parent=objects.key AND e.child=?)
        WHERE v3=1 AND key IN (SELECT parent FROM edges WHERE child=?)`, next.key, next.key);
      await store.boundary();
    }
    demand(position === store.get('SELECT COUNT(*) AS n FROM objects WHERE v3=1').n, 'Publication DAG cycle or incomplete schedule');
    const count = (sql) => store.get(sql).n;
    const diskArray = (length, lookup) => new Proxy([], { get(_target, name) {
      if (name === 'length') return length;
      if (typeof name === 'string' && /^(0|[1-9]\d*)$/.test(name)) return lookup(Number(name));
      return undefined;
    } });
    // Indexed sparse views use the ORIGINAL canonical schedule encoder. No new
    // digest encoding or different semantic key ordering is introduced.
    const externalCount = count('SELECT COUNT(*) AS n FROM objects WHERE external=1');
    // Keyset cursor avoids quadratic OFFSET over hundreds of thousands of files.
    let externalKey = '', externalIndex = -1;
    const externals = diskArray(externalCount, (index) => {
      demand(index === externalIndex + 1, 'Non-sequential external schedule projection');
      const row = store.get('SELECT * FROM objects WHERE external=1 AND key>? ORDER BY key COLLATE BINARY LIMIT 1', externalKey);
      externalKey = row.key; externalIndex = index;
      return compact(JSON.parse(row.descriptor));
    });
    const entries = diskArray(position, (index) => {
      const row = store.get('SELECT * FROM objects WHERE v3=1 AND position=?', index + 1);
      const value = JSON.parse(row.descriptor);
      const changed = [], external = [], changedOrder = [], externalOrder = [];
      for (const edge of store.iterate('SELECT e.*,o.v3 FROM edges e JOIN objects o ON o.key=e.child WHERE e.parent=? ORDER BY e.child COLLATE BINARY', row.key)) {
        (edge.relation === 'content' ? edge.v3 ? changed : external : edge.v3 ? changedOrder : externalOrder).push(edge.child);
      }
      return { position: index + 1, key: row.key, byte_size: row.size, sha256: row.sha,
        publication_stage: row.stage, dependencies: value.dependencies, publication_prerequisites: value.publication_prerequisites,
        changed_dependencies: changed, external_dependencies: external,
        changed_publication_prerequisites: changedOrder, external_publication_prerequisites: externalOrder };
    });
    const content = count("SELECT COUNT(*) AS n FROM edges e JOIN objects p ON p.key=e.parent JOIN objects c ON c.key=e.child WHERE p.v3=1 AND c.v3=1 AND e.relation='content'");
    const order = count("SELECT COUNT(*) AS n FROM edges e JOIN objects p ON p.key=e.parent JOIN objects c ON c.key=e.child WHERE p.v3=1 AND c.v3=1 AND e.relation='order'");
    const schedule = { contract_version: OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT,
      tie_breaker: 'publication_stage_then_bytewise_utf8_key_among_eligible_nodes',
      changed_dependency_edge_count: content + order, changed_content_dependency_edge_count: content,
      changed_order_prerequisite_edge_count: order, external_reference_count: externalCount,
      external_references: externals, entries };
    const hash = createHash('sha256'); let chunks = 0;
    for (const chunk of canonicalObservationHistoryIndexV3JsonChunks(schedule)) {
      hash.update(chunk); if (++chunks % 8192 === 0) await store.boundary(true);
    }
    this.scheduleSha256 = hash.digest('hex');
    for (const row of store.iterate('SELECT * FROM publications ORDER BY id')) {
      const value = JSON.parse(row.evidence);
      const expected = store.get('SELECT * FROM objects WHERE v3=1 AND key=?', value.key);
      demand(expected && value.byte_size === expected.size && value.sha256 === expected.sha &&
        value.position === expected.position && value.schedule_sha256 === this.scheduleSha256 &&
        value.post_put_get_verified === true && (value.publication_stage === undefined || value.publication_stage === expected.stage) &&
        (value.verified === undefined || value.verified === true) && (value.durable === undefined || value.durable === true),
      `Publication evidence contradicts immutable schedule: ${value.key}`);
      await store.boundary();
    }
    demand(!store.get('SELECT o.key FROM objects o WHERE o.v3=1 AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.key=o.key) LIMIT 1'),
      'Complete publication evidence/changed dependency closure missing');
  }
}

export async function readBoundedBaseline({ checkpointPath, planReport, evidenceRoot, store, repositoryRoot, environment, bucket }) {
  const { value: checkpoint, bytes } = readJsonBounded(checkpointPath, 4 * MiB);
  const checkpointIdentity = { sha256: sha256(bytes), byte_size: bytes.length };
  demand(checkpoint.kind === 'uk_aq_observation_history_v3_migration_checkpoint' &&
    checkpoint.progress_format === 'authenticated-journal-v1' && checkpoint.authority_format === 'uk_aq_migration_plan_shards_v1' &&
    checkpoint.authority_ref?.full_plan_sha256 === checkpoint.authority_sha256 && checkpoint.clean_target_admission === null &&
    same(checkpoint.prepared_units, {}) && same(checkpoint.completed_objects, {}) && same(checkpoint.preparation_order, []) &&
    checkpoint.full_verification_complete === false && checkpoint.cutover_ready === false,
  'Bounded verifier requires the original immutable empty sharded-journal checkpoint; no converted or rewritten evidence accepted');
  const manifest = envelope(`${path.resolve(checkpointPath)}.recovery/manifest.json`, 'uk_aq_observation_history_v3_recovery_manifest').value;
  const relocation = createEvidenceRelocation({ historicalCheckpointPath: manifest.payload.original_checkpoint.path,
    localCheckpointPath: checkpointPath, evidenceRoot });
  store.phase = 'authenticate-sharded-plan';
  const disk = await new DiskPlan(store).importShards(checkpoint.authority_ref, relocation.mapHistoricalPath);
  demand(await disk.hash(disk.at('plan_identity')) === checkpoint.plan_sha256, 'Migration plan SHA-256 differs');
  const plan = {};
  for (const field of ['generation_topology', 'transition', 'environment', 'migration_run_id', 'plan_sha256',
    'target_observations_prefix', 'target_writer_git_sha', 'target', 'v3_index_root', 'v3_latest_key',
    'planning_clean_target_admission', 'runner', 'writer_freeze_plan', 'sos_connector_id']) plan[field] = disk.value(field);
  plan.inventory = { observations_prefix: disk.value('inventory', 'observations_prefix'), root_manifest: disk.value('inventory', 'root_manifest') };
  plan.plan_identity = {};
  for (const field of ['runner_policy', 'source_root', 'transition', 'environment', 'bucket', 'generation_topology',
    'target_observations_prefix', 'target_writer_git_sha', 'migration_run_id', 'v3_index_root', 'v3_latest_key', 'writer_limits']) {
    plan.plan_identity[field] = disk.value('plan_identity', field);
  }
  const identity = plan.plan_identity, v2 = getObservationHistoryGeneration('v2'), v3 = getObservationHistoryGeneration('v3');
  demand(plan.generation_topology === 'observation-history-side-by-side-v1' && identity.generation_topology === plan.generation_topology &&
    same(plan.transition, normalizeObservationHistoryV3MigrationTransition('v2-to-v3')) && same(checkpoint.transition, plan.transition) &&
    same(identity.transition, plan.transition) && plan.inventory.observations_prefix === v2.observations_prefix &&
    plan.target_observations_prefix === v3.observations_prefix && plan.v3_index_root === v3.observations_timeseries_index_prefix &&
    plan.v3_latest_key === v3.observations_timeseries_latest_key && same(identity.writer_limits, plan.target.writer_limits) &&
    identity.source_root.key === plan.inventory.root_manifest.key && identity.source_root.byte_size === plan.inventory.root_manifest.byte_size &&
    identity.source_root.sha256 === plan.inventory.root_manifest.sha256 && same(identity.runner_policy, GCP_CLEAN_POLICY),
  'Side-by-side generation/source/writer/runner identity differs');
  for (const field of ['target_observations_prefix', 'target_writer_git_sha', 'migration_run_id', 'v3_index_root', 'v3_latest_key'])
    demand(identity[field] === plan[field], `Pinned plan ${field} differs`);
  demand(plan.environment.environment === environment && plan.environment.bucket === bucket && identity.environment === environment &&
    identity.bucket === bucket && checkpoint.migration_run_id === plan.migration_run_id && checkpoint.plan_sha256 === plan.plan_sha256 &&
    planReport?.result?.plan_sha256 === plan.plan_sha256 && planReport?.result?.migration_run_id === plan.migration_run_id &&
    plan.writer_freeze_plan?.entries?.length > 0, 'Explicit environment/report/complete freeze authority differs');
  for (const field of ['bindings', 'empty_source_connectors']) demand(await disk.hash(disk.at(field)) ===
    await disk.hash(disk.at('plan_identity', field)), `Pinned ${field} differs`);
  const trust = authenticateCutoverVerifierDependencies({ repositoryRoot, historicalWriterGitSha: plan.target_writer_git_sha });
  checkpoint.authority = plan; // Small projection; original bytes stay immutable.
  const baseline = new BoundedBaseline(store, disk, checkpoint, plan);
  baseline.unitCount = disk.length(disk.at('units'));
  demand(baseline.unitCount > 0 && disk.length(disk.at('plan_identity', 'unit_ids')) === baseline.unitCount, 'Unit count differs');
  let nextPrepared = 0;
  store.phase = 'authenticate-journal';
  const journal = await authenticateDiskJournal({ checkpoint, checkpointIdentity, checkpointPath, store,
    anchorSequence: plan.migration_run_id === EXCEPTIONAL_LIVE_RECOVERY.run_id ? EXCEPTIONAL_LIVE_RECOVERY.journal_sequence : 0,
    validateUpdateStructure: validateRecoveryUpdateStructure,
    onEntry: async (updates) => {
      if (updates.clean_target_admission) {
        demand(!checkpoint.clean_target_admission, 'Clean-start admission redefined');
        validateCleanStartEvidence(updates.clean_target_admission, plan); checkpoint.clean_target_admission = updates.clean_target_admission;
      }
      if ((updates.prepared_records?.length || updates.completed_objects?.length || updates.publication_evidence?.length))
        demand(checkpoint.clean_target_admission, 'Target progress precedes clean-start admission');
      const records = updates.prepared_records || [], order = updates.preparation_order_append || [];
      demand(records.length === order.length, 'Preparation order/record count differs');
      for (const [index, entry] of records.entries()) {
        const ordinal = nextPrepared++;
        const authorityUnit = disk.value('units', String(ordinal));
        demand(entry.unit_id === order[index] && entry.unit_id === authorityUnit.unit_id &&
          disk.value('plan_identity', 'unit_ids', String(ordinal)) === entry.unit_id && entry.record?.unit_id === entry.unit_id,
        'Preparation does not follow complete immutable order');
        store.run('INSERT INTO prepared VALUES(?,?,?)', entry.unit_id, ordinal, JSON.stringify(entry.record));
      }
      for (const entry of updates.prepared_state_updates || []) {
        const row = store.get('SELECT record FROM prepared WHERE id=?', entry.unit_id);
        demand(row, 'State update for unknown prepared unit'); const record = JSON.parse(row.record);
        if (entry.files_published === true) record.files_published = true;
        if (entry.remove_staging_refs === true) record.target_file_intents = record.target_file_intents.map(({ staging_ref: _ref, ...intent }) => intent);
        store.run('UPDATE prepared SET record=? WHERE id=?', JSON.stringify(record), entry.unit_id);
      }
      for (const entry of updates.publication_evidence || []) {
        demand(entry && typeof entry.key === 'string', 'Invalid publication record');
        store.run('INSERT INTO publications(key,evidence) VALUES(?,?)', entry.key, JSON.stringify(entry)); store.counters.publication_records++;
      }
      if (updates.final_state) {
        demand((!checkpoint.full_verification_complete || updates.final_state.full_verification_complete) &&
          (!checkpoint.cutover_ready || updates.final_state.cutover_ready), 'Final state regresses');
        Object.assign(checkpoint, updates.final_state);
      }
    } });
  demand(nextPrepared === baseline.unitCount && checkpoint.full_verification_complete === true && checkpoint.cutover_ready === true,
    'Incomplete migration journal; final complete/cutover-ready state required');
  validateCleanStartEvidence(checkpoint.clean_target_admission, plan);
  demand(manifest.payload.recovery_implementation.runner?.runner_kind === plan.runner.runner_kind &&
    manifest.payload.recovery_implementation.runner?.runner_profile === plan.runner.runner_profile, 'Historical runner identity differs');
  let exceptional = null;
  if (plan.migration_run_id === EXCEPTIONAL_LIVE_RECOVERY.run_id) exceptional = authenticateExceptionalRecovery({
    checkpointPath, repositoryRoot, authenticatedJournal: journal, authenticatedCheckpoint: checkpoint,
    authenticatedCheckpointBytes: bytes, evidenceRoot });
  else demand(environment === 'TEST', 'Unknown LIVE migration requires separately reviewed recovery authority');
  // Reuse the exact shared replay digest implementation, substituting bounded
  // ordered disk iterators for its default Object.entries arrays.
  store.phase = 'authenticate-replay-digest';
  const preparedEntries = { length: store.count('prepared'), *[Symbol.iterator]() {
    for (const row of store.iterate('SELECT id,record FROM prepared ORDER BY id COLLATE BINARY')) {
      store.assertHeld(); store.progress(); yield [row.id, JSON.parse(row.record)];
    }
  } };
  const completedEntries = { length: store.count('completed'), *[Symbol.iterator]() {
    for (const row of store.iterate('SELECT key,evidence FROM completed ORDER BY key COLLATE BINARY')) {
      store.assertHeld(); store.progress(); yield [row.key, JSON.parse(row.evidence)];
    }
  } };
  const preparationOrder = { length: baseline.unitCount, *entries() {
    for (const row of store.iterate('SELECT ordinal,id FROM prepared ORDER BY ordinal')) yield [row.ordinal, row.id];
  } };
  baseline.replaySha256 = buildObservationHistoryV3RecoveryReplayStateSha256(checkpoint, { preparationOrder, preparedEntries, completedEntries });
  baseline.provenance = { kind: 'authenticated_completed_migration_disk_replay', ...checkpointIdentity,
    checkpoint_sha256: checkpointIdentity.sha256, checkpoint_byte_size: checkpointIdentity.byte_size,
    immutable_authority_sha256: checkpoint.authority_sha256, recovery_head_sha256: journal.headIdentity.sha256,
    recovery_last_sequence: journal.last_sequence, recovery_last_entry_sha256: journal.last_entry_sha256,
    replay_state_sha256: baseline.replaySha256, verifier_trust: trust,
    authenticated_unique_completed_objects: store.count('completed'),
    evidence_relocation: { historical_checkpoint_path: relocation.historical_checkpoint_path,
      local_checkpoint_path: relocation.local_checkpoint_path, evidence_root: relocation.evidence_root, relocated: relocation.relocated },
    exceptional_recovery: exceptional ? { original_writer_git_sha: exceptional.originalImplementation.repository_head,
      recovery_epoch_sequence: exceptional.recoveryEpoch.sequence, recovery_epoch_sha256: exceptional.recoveryEpoch.last_epoch_sha256 } : null };
  baseline.journal = journal;
  await baseline.buildDependencies();
  return baseline;
}
