#!/usr/bin/env node
// Offline only: no environment credentials, remote clients, writes to source, or AQI calculation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { canonicalJson, aqiEndpointCompleteness, indexCompleteness } from '../compressed_chart_history/export.mjs';
import { openBackupSource } from '../jsongen/bootstrap/source.mjs';
import { authenticatedTerminalSourceDay } from '../jsongen/bootstrap/currentness.mjs';
import { check, sameIdentity, monthBounds, validateSelection, selectionKey, objectKey, HISTORY_JSON_ALGORITHM, SHA256 } from '../../workers/shared/uk_aq_historical_json.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b, code) => check(canonicalJson(a).equals(canonicalJson(b)), code);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function readBounded(file, max = 16 * 1024 ** 2) {
  const stat = await fs.stat(file); check(stat.isFile() && stat.size > 0 && stat.size <= max, 'file_size_invalid');
  return fs.readFile(file);
}
async function readRef(root, ref) {
  check(ref && SHA256.test(ref.sha256 || '') && Number.isSafeInteger(ref.byte_size), 'reference_invalid');
  const file = await fs.realpath(path.resolve(root, ref.path || ''));
  check(file.startsWith(`${await fs.realpath(root)}${path.sep}`), 'reference_outside_candidate');
  const bytes = await readBounded(file);
  check(bytes.length === ref.byte_size && sha(bytes) === ref.sha256, 'referenced_bytes_mismatch');
  return bytes;
}
async function newPrivateDir(output) {
  check(path.isAbsolute(output) && !path.resolve(output).startsWith(`${path.dirname(repo)}${path.sep}`), 'output_must_be_outside_workspace');
  const parent = await fs.realpath(path.dirname(output)), workspace = await fs.realpath(path.dirname(repo));
  check(parent !== workspace && !parent.startsWith(`${workspace}${path.sep}`), 'output_parent_must_be_private');
  await fs.mkdir(output, { mode: 0o700 }); // never overwrite an earlier admission
}
function validateCurrentness(current, month, pm) {
  check(current?.month_utc === month && current.matches === true && current.proof_state === 'established'
    && current.result?.matches === true && current.result.month_matches === true && current.result.terminal_matches === true,
  'currentness_not_established');
  const c = current.currentness;
  check(c?.source_authority_established === true && c.canonical_authority_established === true
    && SHA256.test(c.source_content_hash || '') && c.source_content_hash === c.canonical_content_hash, 'month_authority_mismatch');
  const deps = [...(current.terminal_days || []), ...(pm ? current.context_days || [] : [])];
  check(current.terminal_days?.length === 1 && (!pm || current.context_days?.length === 1), 'dependency_proof_missing');
  deps.forEach(d => check(d.matches === true && d.source_authority_established === true && d.canonical_authority_established === true
    && SHA256.test(d.source_manifest_hash || '') && d.source_manifest_hash === d.canonical_manifest_hash, 'dependency_authority_mismatch'));
  return c.source_content_hash;
}
export async function inspectCandidate(candidateDir, policy) {
  check(policy.schema_version === 1 && policy.mode === 'manual_isolated_test' && Array.isArray(policy.allowed), 'policy_invalid');
  const completeBytes = await readBounded(path.join(candidateDir, 'COMPLETE.json'));
  const complete = JSON.parse(completeBytes), reportBytes = await readBounded(path.join(candidateDir, 'report.json'));
  check(complete.schema_version === 1 && complete.kind === 'uk_aq_jsongen_local_bootstrap_completion'
    && sha(reportBytes) === complete.report_sha256, 'completion_report_invalid');
  const report = JSON.parse(reportBytes), manifestBytes = await readRef(candidateDir, complete.manifest), m = JSON.parse(manifestBytes);
  check(report.environment === 'TEST' && report.state === 'local_candidates_complete' && report.errors.length === 0
    && report.incomplete_scopes.length === 0 && report.remote_write_operations === 0, 'bootstrap_not_complete');
  same(report.manifest, complete.manifest, 'report_manifest_mismatch');
  check(m.environment === 'TEST' && m.source_complete === true && m.aqi_complete === true && m.terminal_source_complete === true
    && m.managed_publication_eligible === false && m.candidates.length === 1, 'manual_single_pair_required');
  const summary = m.candidates[0], descriptorBytes = await readRef(candidateDir, summary.candidate), d = JSON.parse(descriptorBytes);
  check(d.kind === 'uk_aq_jsongen_bootstrap_monthly_pair_candidate' && d.schema_version === 1 && d.environment === 'TEST'
    && d.local_candidate_complete === true && d.raw_observation_candidate_complete === true && d.derived_aqi_candidate_complete === true
    && d.manual_review_eligible === true && d.managed_publication_eligible === false, 'candidate_not_admissible');
  check(policy.allowed.some(x => sameIdentity(x, d.identity) && x.month_utc === d.month_utc
    && x.algorithm_version === d.calculation_dependencies.version), 'scope_not_authorised');
  check(Array.isArray(d.unresolved_authority) && d.unresolved_authority.every(x => policy.allowed_unresolved_managed_authority.includes(x)), 'unapproved_authority_limitation');
  same(summary.identity, d.identity, 'summary_identity_mismatch');
  check(summary.pub_id === d.pub_id && summary.month_utc === d.month_utc, 'summary_version_mismatch');
  for (const kind of ['observations', 'aqi']) same(summary[kind], d[kind], 'summary_object_mismatch');
  check(report.candidates.some(c => c.candidate?.sha256 === summary.candidate.sha256 && c.pub_id === d.pub_id), 'report_pair_missing');
  const b = monthBounds(d.month_utc), pm = d.identity.pollutant_code !== 'no2';
  check(d.coverage.month_utc === d.month_utc && d.coverage.partial_month === false && d.coverage.requested_start_utc === b.start_utc
    && d.coverage.requested_end_exclusive_utc === b.end_utc && d.coverage.month_start_utc === b.start_utc
    && d.coverage.month_end_exclusive_utc === b.end_utc, 'full_month_required');
  const monthHash = validateCurrentness(d.currentness.initial, d.month_utc, pm);
  check(monthHash === validateCurrentness(d.currentness.final, d.month_utc, pm), 'source_changed');
  check(d.source_stability?.state === 'original_selected_proof_revalidated' && d.source_stability.failures.length === 0
    && d.source_stability.raw_observation_failures.length === 0 && !d.source_stability.generation_failure, 'source_stability_failed');
  const evidence = JSON.parse(await readRef(candidateDir, d.source_evidence));
  check(evidence.environment === 'TEST' && evidence.kind === 'uk_aq_jsongen_dropbox_bootstrap_source_evidence', 'source_evidence_invalid');
  same(evidence.source_checkpoint, d.source_checkpoint, 'checkpoint_pair_mismatch');
  same(report.source_checkpoint, d.source_checkpoint, 'checkpoint_report_mismatch');
  same(evidence.month, d.coverage, 'source_period_mismatch');
  const metadata = new Map();
  for (const ref of evidence.metadata_objects) {
    const bytes = await readRef(candidateDir, { ...ref, path: `evidence/source/${ref.sha256}.json` });
    metadata.set(ref.key, { ref, bytes, value: JSON.parse(bytes) });
  }
  check(metadata.get(d.source_checkpoint.key)?.ref.sha256 === d.source_checkpoint.sha256, 'checkpoint_evidence_missing');
  // Reuse Bootstrap's actual checkpoint/manifest/packed-binding validators against retained
  // bytes. This adapter has no network or fallback method and cannot retrieve Parquet.
  const offlineReader = { inventory: new Map([...metadata].map(([key, item]) => [key, item.ref])),
    async read(key, { expected } = {}) {
      const item = metadata.get(key); check(item, 'required_source_metadata_not_retained');
      if (expected) check(item.ref.sha256 === expected.sha256 && (expected.byte_size === undefined
        || item.ref.byte_size === expected.byte_size), 'source_ancestry_mismatch');
      return { key, body: item.bytes, sha256: item.ref.sha256, byte_size: item.ref.byte_size };
    },
    async json(key, options) { return JSON.parse((await this.read(key, options)).body); },
  };
  const authenticated = await openBackupSource(offlineReader, { checkpointSha256: d.source_checkpoint.sha256,
    observationsRoot: d.source_checkpoint.processed_observations_root_hash, limits: { series: 1 },
    verificationModes: { [d.identity.connector_id]: evidence.verification_mode } });
  same(authenticated.checkpoint, d.source_checkpoint, 'authenticated_checkpoint_mismatch');
  const authenticatedBinding = await authenticated.binding(d.identity.timeseries_id, d.identity.connector_id, d.identity.pollutant_code);
  check(sameIdentity(authenticatedBinding, d.identity), 'authenticated_binding_identity_mismatch');
  const sourceAuthority = await authenticated.authority(d.identity.connector_id);
  const knownFiles = new Map();
  for (const day of evidence.days) {
    const manifest = await authenticated.pollutant(day.day_utc, d.identity.connector_id, d.identity.pollutant_code);
    check(manifest ? day.source_state === 'authenticated_membership' : day.source_state === 'authoritative_absence', 'source_day_membership_mismatch');
    for (const file of manifest?.files || []) knownFiles.set(file.key, file);
    if (day.dependency_role === 'raw_observations' && manifest?.timeseries_row_counts) {
      const actual = d.observation_completeness.days.find(x => x.day_utc === day.day_utc)?.row_count;
      check(actual === (manifest.timeseries_row_counts[d.identity.timeseries_id] || 0), 'physical_source_count_mismatch');
    }
  }
  for (const file of evidence.consumed_parquet) {
    const canonical = knownFiles.get(file.key);
    check(canonical && (canonical.sha256 || canonical.etag_or_hash) === file.sha256 && canonical.bytes === file.byte_size,
      'consumed_source_file_not_authenticated');
  }

  const bindingRef = evidence.physical_bindings.find(x => x.key.endsWith(`/timeseries_id=${d.identity.timeseries_id}.json`));
  const pack = metadata.get(bindingRef?.pack_key)?.value;
  check(pack?.source_range_hash === bindingRef?.source_range_hash, 'binding_pack_missing');
  const member = pack.members.find(x => x.relative_path === bindingRef.key), bindingBytes = Buffer.from(member?.body_base64 || '', 'base64');
  check(sha(bindingBytes) === bindingRef.sha256 && bindingBytes.length === bindingRef.byte_size
    && member.sha256 === bindingRef.sha256, 'binding_member_invalid');
  const binding = JSON.parse(bindingBytes);
  check(sameIdentity(binding, d.identity) && binding.schema_version === 1 && !binding.continuity, 'physical_binding_unsupported');
  const verification = metadata.get(evidence.verification?.latest_identity?.key);
  check(verification?.ref.sha256 === evidence.verification.latest_identity.sha256, 'verification_evidence_missing');
  // The first manual policy explicitly accepts authenticated backup/physical binding authority;
  // it does not invent current Core or all-writer managed authority.
  check(evidence.verification_mode === 'pre_overlay_accepted' && evidence.verification.overlay_authoritative === false
    && !verification.value.connectors.some(x => x.connector_id === d.identity.connector_id), 'verification_mode_not_supported');
  check(evidence.verification_binding_authority?.packed_physical_bindings === 'authenticated_from_selected_backup', 'binding_authority_missing');
  for (const current of [d.currentness.initial, d.currentness.final]) {
    for (const ref of [current.canonical_scope.month, ...current.terminal_days.map(x => x.month), ...(pm ? current.context_days.map(x => x.month) : [])])
      check(metadata.get(ref.key)?.ref.sha256 === ref.object_sha256, 'currentness_metadata_not_retained');
  }
  const products = {};
  for (const kind of ['observations', 'aqi']) {
    const bytes = await readRef(candidateDir, d[kind]), raw = gunzipSync(bytes, { maxOutputLength: 32 * 1024 ** 2 });
    check(raw.length === d[kind].json_byte_size && sha(raw) === d[kind].json_sha256, 'decoded_bytes_mismatch');
    const x = JSON.parse(raw);
    check(x.schema_version === 1 && x.kind === `uk_aq_jsongen_bootstrap_${kind}_candidate` && x.pub_id === d.pub_id
      && sameIdentity(x.identity, d.identity) && x.month_utc === d.month_utc && x.environment === 'TEST', 'product_identity_mismatch');
    for (const key of ['source_checkpoint', 'source_evidence', 'calculation_dependencies', 'coverage']) same(x[key], d[key], `product_${key}_mismatch`);
    products[kind] = { bytes, value: x };
  }
  const obs = products.observations.value, aq = products.aqi.value;
  check(Array.isArray(obs.physical_schemas) && obs.physical_schemas.length > 0, "physical_schema_missing");
  obs.physical_schemas.forEach(schema => authenticated.assertStatusMode(schema, d.identity.connector_id, sourceAuthority));
  same(obs.completeness, d.observation_completeness, 'observation_completeness_mismatch');
  same(aq.completeness, d.aqi_completeness, 'aqi_completeness_mismatch');
  same(obs.row_columns, ['observed_at_utc','value','station_id','source_status','verification_status','embedded_verification_status','source_status_provenance'], 'observation_schema_invalid');
  check(obs.canonical_row_multiplicity_preserved === true && obs.completeness.requested_source_complete === true
    && obs.observations.length === d.observation_count, 'observation_source_incomplete');
  let previous = '';
  obs.observations.forEach(row => {
    check(Array.isArray(row) && row.length === 7 && typeof row[0] === 'string' && new Date(row[0]).toISOString() === row[0]
      && row[0] >= b.start_utc && row[0] < b.end_utc && row[0] >= previous && typeof row[1] === 'number' && Number.isFinite(row[1])
      && row[2] === d.identity.station_id && typeof row[6] === 'string', 'observation_row_invalid'); previous = row[0];
  });
  const days = (Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 86400000;
  check(obs.completeness.days.length === days && obs.completeness.days.every((day, i) =>
    day.day_utc === new Date(Date.parse(b.start_utc) + i * 86400000).toISOString().slice(0,10)
    && ['authenticated_membership','authoritative_absence'].includes(day.source_state)
    && day.row_count === obs.observations.filter(r => r[0].startsWith(day.day_utc)).length), 'observation_day_accounting_invalid');
  const dependencies = d.calculation_dependencies, terminal = aq.completeness.terminal_dependency;
  check(dependencies.version === HISTORY_JSON_ALGORITHM && aq.algorithm_version === HISTORY_JSON_ALGORITHM
    && aq.aqi.algorithm_version === HISTORY_JSON_ALGORITHM && dependencies.daqi_pm_window_hours === 24
    && dependencies.daqi_pm_required_valid_hours === 18, 'algorithm_incompatible');
  check(terminal.source_authority_established === true && terminal.source_bytes_authenticated === true
    && terminal.endpoint_utc === b.end_utc && authenticatedTerminalSourceDay(terminal.source_day, b.end_utc.slice(0,10))
    && terminal.source_day.manifest_hash === d.currentness.final.terminal_days[0].source_manifest_hash, 'terminal_authority_invalid');
  check(aq.completeness.context_source_complete === true && (!pm || (aq.completeness.context_day_accounting.length === 1
    && aq.completeness.context_day_accounting[0].day_utc === new Date(Date.parse(b.start_utc)-86400000).toISOString().slice(0,10)
    && ['authenticated_membership','authoritative_absence'].includes(aq.completeness.context_day_accounting[0].source_state))), 'pm_context_invalid');
  const endpoints = aqiEndpointCompleteness(aq.aqi, b.start_utc, b.end_utc, aq.daily_batches);
  check(endpoints.complete, 'aqi_endpoint_grid_invalid'); same(endpoints, aq.completeness.endpoints, 'endpoint_descriptor_mismatch');
  for (const index of ['daqi','eaqi']) {
    const completeness = indexCompleteness(aq.aqi, index, endpoints);
    check(completeness.evaluated_complete, 'index_unevaluated'); same(completeness, aq.completeness[index], 'index_completeness_mismatch');
  }
  aq.aqi.rows.forEach(row => {
    check(sameIdentity(row, d.identity) && row.algorithm_version === HISTORY_JSON_ALGORITHM, 'aqi_row_identity_invalid');
    for (const index of ['daqi','eaqi']) {
      const level = row[`${index}_index_level`], ok = row[`${index}_calculation_status`] === 'ok';
      check(ok ? Number.isInteger(level) && level >= 1 && level <= (index === 'daqi' ? 10 : 6) : level === null, 'index_status_invalid');
      const count = row[`${index}_source_observation_count`], required = row[`${index}_required_observation_count`];
      const countValid = (Number.isSafeInteger(count) && count >= 0) || (count === null
        && row[`${index}_calculation_status`] === 'missing_input' && row[`${index}_missing_reason`] === 'no_input_value');
      check(countValid && required === (index === 'daqi' && pm ? 18 : 1) && (!ok || count >= required), 'index_count_invalid');
      if (ok) check(typeof row[`${index}_input_value_ugm3`] === 'number' && Number.isFinite(row[`${index}_input_value_ugm3`])
        && row[`${index}_input_value_ugm3`] >= 0, 'index_input_invalid');
    }
  });
  check(aq.terminal_source_inputs.length === terminal.input_row_count && aq.terminal_source_inputs.every(row =>
    sameIdentity(row, d.identity) && row.observed_at_utc === b.end_utc && typeof row.value === 'number' && Number.isFinite(row.value)), 'terminal_input_invalid');
  const source = { generation: 'v3', source_as_of_utc: report.currentness.source_as_of, checkpoint_sha256: d.source_checkpoint.sha256, evidence_sha256: d.source_evidence.sha256,
    candidate_sha256: summary.candidate.sha256, binding_sha256: bindingRef.sha256, verification_sha256: verification.ref.sha256,
    month_content_hash: monthHash, terminal_manifest_hash: terminal.source_day.manifest_hash,
    edge_day_proofs: {
      first: metadata.get(`history/v3/observations/day_utc=${b.start_utc.slice(0,10)}/manifest.json`)?.value.manifest_hash || null,
      last: metadata.get(`history/v3/observations/day_utc=${new Date(Date.parse(b.end_utc)-86400000).toISOString().slice(0,10)}/manifest.json`)?.value.manifest_hash || null,
      context: pm ? d.currentness.final.context_days[0].source_manifest_hash : null,
    },
    source_complete: true, terminal_complete: true, context_complete: true };
  const sourceId = sha(canonicalJson(source));
  const selection = { schema_version: 1, kind: 'uk_aq_historical_json_pair_selection', identity: d.identity, month_utc: d.month_utc,
    interval: b, pub_id: d.pub_id, algorithm_version: HISTORY_JSON_ALGORITHM, source_id: sourceId, source,
    admission: { mode: 'manual_isolated_test', managed_publication_eligible: false, unresolved_managed_authority: d.unresolved_authority,
      complete_sha256: sha(completeBytes), report_sha256: sha(reportBytes), readback_verified: false },
    completeness: { observations: true, daqi: aq.completeness.daqi, eaqi: aq.completeness.eaqi }, objects: {} };
  for (const kind of ['observations','aqi']) {
    const { path: _path, ...descriptor } = d[kind];
    selection.objects[kind] = { ...descriptor, row_count: kind === 'aqi' ? aq.aqi.rows.length : obs.observations.length,
      pub_id: d.pub_id, source_id: sourceId, algorithm_version: HISTORY_JSON_ALGORITHM };
  }
  validateSelection({ ...selection, admission: { ...selection.admission, readback_verified: true } });
  return { selection, products };
}
export async function prepare({ candidateDir, policyPath, outputDir }) {
  const policy = JSON.parse(await readBounded(policyPath)), result = await inspectCandidate(candidateDir, policy);
  await newPrivateDir(outputDir);
  for (const kind of ['observations','aqi']) await fs.writeFile(path.join(outputDir, `${kind}.json.gz`), result.products[kind].bytes, { mode: 0o600, flag: 'wx' });
  const plan = { schema_version: 1, selection_key: selectionKey(result.selection.identity, result.selection.month_utc), selection: result.selection,
    uploads: ['observations','aqi'].map(kind => ({ kind, key: objectKey(result.selection, kind), file: `${kind}.json.gz`,
      metadata: { sha256: result.selection.objects[kind].sha256 } })) };
  await fs.writeFile(path.join(outputDir, 'prepared.json'), canonicalJson(plan), { mode: 0o600, flag: 'wx' });
  return { state: 'prepared_not_selected', pub_id: result.selection.pub_id, source_id: result.selection.source_id, uploads: plan.uploads.length };
}
export async function verifyReadback({ preparedDir, readbackDir, selectionOutput }) {
  const plan = JSON.parse(await readBounded(path.join(preparedDir, 'prepared.json')));
  check(plan.selection.admission.readback_verified === false && await fs.realpath(preparedDir) !== await fs.realpath(readbackDir), 'independent_readback_required');
  for (const kind of ['observations','aqi']) {
    const ref = plan.selection.objects[kind], bytes = await readBounded(path.join(readbackDir, `${kind}.json.gz`));
    const head = JSON.parse(await readBounded(path.join(readbackDir, `${kind}.head.json`)));
    check(bytes.length === ref.byte_size && sha(bytes) === ref.sha256 && head.ContentLength === ref.byte_size
      && head.Metadata?.sha256 === ref.sha256 && typeof head.ETag === 'string' && head.ETag.length > 2, 'remote_readback_invalid');
    const raw = gunzipSync(bytes, { maxOutputLength: 32 * 1024 ** 2 });
    check(raw.length === ref.json_byte_size && sha(raw) === ref.json_sha256, 'remote_decoded_bytes_invalid');
    const value = JSON.parse(raw);
    check(value.pub_id === plan.selection.pub_id && sameIdentity(value.identity, plan.selection.identity)
      && value.source_evidence.sha256 === plan.selection.source.evidence_sha256, 'remote_pair_invalid');
  }
  const selection = { ...plan.selection, admission: { ...plan.selection.admission, readback_verified: true } };
  validateSelection(selection);
  check(path.isAbsolute(selectionOutput) && !selectionOutput.startsWith(`${path.dirname(repo)}${path.sep}`), 'selection_output_must_be_private');
  const targetParent = await fs.realpath(path.dirname(selectionOutput)), workspace = await fs.realpath(path.dirname(repo));
  check(targetParent !== workspace && !targetParent.startsWith(`${workspace}${path.sep}`), 'selection_parent_must_be_private');
  await fs.writeFile(selectionOutput, canonicalJson(selection), { mode: 0o600, flag: 'wx' });
  return { state: 'readback_verified_selection_file_only', selection_key: selectionKey(selection.identity, selection.month_utc),
    selection_sha256: sha(canonicalJson(selection)), pub_id: selection.pub_id };
}
const HELP = `Offline manual historical chart JSON admission (no network operations).
prepare --candidate-dir ABS --policy FILE --output-dir NEW_PRIVATE_ABS
verify-readback --prepared-dir ABS --readback-dir ABS --selection-output NEW_PRIVATE_ABS_FILE
Read README.md before any separately authorised remote publication. Never upload prepared.json as a selection.`;
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') return console.log(HELP);
  const command = args.shift(), options = {};
  const keys = command === 'prepare' ? ['candidate-dir','policy','output-dir'] : command === 'verify-readback' ? ['prepared-dir','readback-dir','selection-output'] : [];
  check(keys.length > 0 && args.length === keys.length * 2, 'arguments_invalid');
  for (let i=0; i<args.length; i+=2) {
    const key = args[i].replace(/^--/, ''); check(keys.includes(key) && !Object.hasOwn(options,key), 'argument_invalid'); options[key] = args[i+1];
  }
  const result = command === 'prepare'
    ? await prepare({ candidateDir: options['candidate-dir'], policyPath: options.policy, outputDir: options['output-dir'] })
    : await verifyReadback({ preparedDir: options['prepared-dir'], readbackDir: options['readback-dir'], selectionOutput: options['selection-output'] });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode=1; });
