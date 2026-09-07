import http from 'node:http';
import os from 'node:os';
import { getObservationHistoryGeneration } from '../../../workers/shared/uk_aq_observation_history_generation.mjs';

const admitted = new WeakSet();
export const GCP_PROFILE = 'gcp-c4a-32';
export const LOCAL_CONCURRENCY = Object.freeze({ partitionDefault: 1, partitionMax: 4, publicationDefault: 1, publicationMax: 16 });
const GCP_CONCURRENCY = Object.freeze({ partitionDefault: 16, partitionMax: 24, publicationDefault: 64, publicationMax: 96 });
export function migrationConcurrencyLimits(permit = null) {
  if (permit === null) return LOCAL_CONCURRENCY;
  if (!admitted.has(permit)) throw new Error('High concurrency requires this process to pass GCE admission');
  return GCP_CONCURRENCY;
}
export function validateMigrationConcurrency({ partitionConcurrency = 1, publicationConcurrency = 1, runnerPermit = null }) {
  const limits = migrationConcurrencyLimits(runnerPermit);
  for (const [name, value, max] of [['partition', partitionConcurrency, limits.partitionMax], ['publication', publicationConcurrency, limits.publicationMax]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${name}-concurrency must be an integer from 1 to ${max}`);
  }
}

// Fixed link-local endpoint, direct node:http (no proxy/env host), no redirects,
// bounded response and wall time. No credentials or identity tokens requested.
function readGceMetadata(key) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '169.254.169.254', port: 80,
      path: `/computeMetadata/v1/${key}`, headers: { 'Metadata-Flavor': 'Google' }, agent: false }, (response) => {
      if (response.statusCode !== 200 || response.headers['metadata-flavor'] !== 'Google') {
        response.resume();
        request.destroy(new Error(`GCE metadata admission failed for ${key}: invalid status/flavor`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4096) request.destroy(new Error(`GCE metadata response too large: ${key}`));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ flavor: response.headers['metadata-flavor'], value: Buffer.concat(chunks).toString('utf8').trim() }));
    });
    const timer = setTimeout(() => request.destroy(new Error(`GCE metadata service unavailable: ${key}`)), 3000);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
  });
}

// Injection exists solely as a narrow programmatic structural-validation seam.
// Neither CLI accepts a client/host/resource override or a pre-attested env flag.
export async function admitGcpRunner({ profile = GCP_PROFILE, metadataClient = readGceMetadata,
  resources = () => ({ architecture: process.arch, available_parallelism: os.availableParallelism(), total_visible_memory: os.totalmem() }) } = {}) {
  if (profile !== GCP_PROFILE) throw new Error(`Unsupported GCP runner profile: ${profile}`);
  const keys = ['instance/id', 'instance/name', 'project/project-id', 'project/numeric-project-id', 'instance/zone', 'instance/machine-type'];
  const results = await Promise.allSettled(keys.map((key) => metadataClient(key)));
  const values = results.map((result, i) => {
    if (result.status === 'rejected') throw new Error(`GCE metadata admission failed: ${keys[i]}`, { cause: result.reason });
    if (result.value?.flavor !== 'Google' || !result.value.value || /[\x00-\x1f\x7f]/.test(result.value.value)) throw new Error(`Invalid GCE metadata: ${keys[i]}`);
    return result.value.value;
  });
  const [instanceId, instanceName, projectId, projectNumber, zonePath, machinePath] = values;
  const zone = /^projects\/([0-9]+)\/zones\/([a-z][a-z0-9-]+)$/.exec(zonePath);
  // GCE's predefined machine-type key is projects/NUMBER/machineTypes/TYPE.
  const machine = /^projects\/([0-9]+)\/machineTypes\/([a-z][a-z0-9-]+)$/.exec(machinePath);
  if (!/^[0-9]+$/.test(instanceId) || !/^[a-z][a-z0-9-]{0,62}$/.test(instanceName) ||
      !/^[a-z][a-z0-9:.-]+$/.test(projectId) || !/^[0-9]+$/.test(projectNumber) ||
      !zone || !machine || zone[1] !== projectNumber || machine[1] !== projectNumber || machine[2] !== 'c4a-standard-32') {
    throw new Error('Contradictory GCE identity or unsupported machine type; gcp-c4a-32 requires c4a-standard-32');
  }
  const actual = resources();
  if (actual.architecture !== 'arm64' || !Number.isInteger(actual.available_parallelism) || actual.available_parallelism < 32 ||
      !Number.isFinite(actual.total_visible_memory) || actual.total_visible_memory < 120 * 1024 ** 3) {
    throw new Error('gcp-c4a-32 requires arm64, at least 32 available CPUs and 120 GiB visible RAM');
  }
  const permit = Object.freeze({ runner_kind: 'gcp', runner_profile: profile, instance_id: instanceId,
    instance_name: instanceName, project_id: projectId, project_number: projectNumber,
    zone: zone[2], machine_type: machine[2], ...actual, metadata_flavor: 'Google' });
  admitted.add(permit);
  return permit;
}

export function cleanTargetNamespaces() {
  const v3 = getObservationHistoryGeneration('v3');
  return [v3.observations_prefix + '/', v3.observations_timeseries_index_prefix + '/',
    v3.timeseries_binding_index_prefix + '/', v3.observations_timeseries_latest_key,
    v3.observations_runs_prefix.slice(0, -'/runs'.length) + '/'];
}
export const GCP_CLEAN_POLICY = Object.freeze({ runner_kind: 'gcp', runner_profile: GCP_PROFILE,
  clean_target_required: true, admission_version: 'empty-v3-observations-v1' });

export async function inspectEmptyV3Target({ listObjects, assertLockHeld, phase }) {
  const namespaces = [];
  for (const prefix of cleanTargetNamespaces()) {
    assertLockHeld();
    const result = await listObjects({ prefix, max_keys: 5 });
    assertLockHeld();
    if (!Array.isArray(result?.entries) || typeof result.is_truncated !== 'boolean') throw new Error(`Invalid clean-target LIST result: ${prefix}`);
    const keys = result.entries.map((object) => object.key);
    if (keys.some((key) => typeof key !== 'string' || !key.startsWith(prefix))) throw new Error(`Contradictory clean-target LIST: ${prefix}`);
    if (keys.length || result.is_truncated) {
      const error = new Error(`Clean v3 target required: namespace=${prefix} count${result.is_truncated ? '>=' : '='}${keys.length} keys=${JSON.stringify(keys)}; manual cleanup required; this runner never deletes objects`);
      error.clean_target_admission = { empty: false, phase, namespace: prefix, observed_count: keys.length, truncated: result.is_truncated, first_keys: keys };
      throw error;
    }
    namespaces.push({ namespace: prefix, empty: true });
  }
  return { admission_version: GCP_CLEAN_POLICY.admission_version, phase, empty: true,
    lock_held: true, checked_at_utc: new Date().toISOString(), namespaces };
}
export function validateCleanStartEvidence(evidence, plan) {
  if (!plan.plan_identity?.runner_policy) return;
  const policy = plan.plan_identity.runner_policy;
  if (Object.keys(policy).length !== Object.keys(GCP_CLEAN_POLICY).length ||
      Object.entries(GCP_CLEAN_POLICY).some(([key, value]) => policy[key] !== value)) throw new Error('Unsupported clean-build policy');
  const completeNamespaces = (entry) => entry?.admission_version === GCP_CLEAN_POLICY.admission_version &&
    entry.empty === true && entry.lock_held === true && Number.isFinite(Date.parse(entry.checked_at_utc)) &&
    Array.isArray(entry.namespaces) && JSON.stringify(entry.namespaces.map((item) => item.namespace)) === JSON.stringify(cleanTargetNamespaces()) &&
    entry.namespaces.every((item) => item.empty === true);
  if (!completeNamespaces(plan.planning_clean_target_admission) || plan.planning_clean_target_admission.phase !== 'plan') throw new Error('Pinned planning clean-target admission is missing or invalid');
  if (!completeNamespaces(evidence) || evidence.phase !== 'migrate-before-first-write' || evidence.plan_sha256 !== plan.plan_sha256 ||
      evidence.migration_run_id !== plan.migration_run_id || evidence.source_root_sha256 !== plan.plan_identity.source_root.sha256) {
    throw new Error('Authenticated clean-start evidence is missing or contradicts migration authority');
  }
}
