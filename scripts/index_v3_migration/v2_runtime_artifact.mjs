// Current executor machinery. This module does not redefine historical migration semantics.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const RUNTIME_KIND = 'uk_aq_index_v3_v2_runtime_rollback_record';
export const RUNTIME_ROLES = ['stable_observations_worker', 'stable_station_worker', 'cache_worker'];
export const runtimeJson = value => `${JSON.stringify(sort(value), null, 2)}\n`;
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
}
export const runtimeSha = value => crypto.createHash('sha256').update(value).digest('hex');
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function keys(value, names, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && runtimeJson(Object.keys(value).sort()) === runtimeJson([...names].sort()), `${label}: unsupported fields`);
}
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
const sha = value => /^[0-9a-f]{64}$/.test(value || '');
const gitSha = value => /^[0-9a-f]{40}$/.test(value || '');
const name = value => typeof value === 'string' && /^[a-zA-Z0-9_./-]+$/.test(value) && !value.split('/').includes('..') && !value.startsWith('/');

// Only these bindings can be round-tripped without interpreting an opaque resource.
// Secret text is deliberately represented by names only, under an explicit policy.
export function runtimeDescriptor(detail) {
  const resources = detail?.resources;
  requireThat(Array.isArray(resources?.bindings), 'Runtime binding metadata is missing');
  const bindings = resources.bindings.map(binding => {
    const allowed = {
      plain_text: ['name', 'type', 'text'], json: ['name', 'type', 'json'],
      r2_bucket: ['name', 'type', 'bucket_name', ...(binding.jurisdiction === undefined ? [] : ['jurisdiction'])],
      service: ['name', 'type', 'service', ...(binding.environment === undefined ? [] : ['environment']), ...(binding.entrypoint === undefined ? [] : ['entrypoint'])],
      secret_text: ['name', 'type'],
    }[binding.type];
    requireThat(allowed, `Unsupported runtime binding type: ${binding.type}`);
    keys(binding, allowed, 'Runtime binding');
    requireThat(name(binding.name), 'Invalid runtime binding name');
    if (binding.type === 'plain_text') requireThat(typeof binding.text === 'string' && !/(secret|token|password|private.?key)/i.test(binding.name), 'Sensitive plain-text binding cannot be archived');
    if (binding.type === 'json') requireThat(!/(secret|token|password|private.?key)/i.test(runtimeJson(binding.json)), 'Sensitive JSON binding cannot be archived');
    if (binding.type === 'service') requireThat(name(binding.service) && (!binding.environment || binding.environment === 'production'), 'Unsupported service environment');
    if (binding.type === 'r2_bucket') requireThat(name(binding.bucket_name), 'Invalid R2 bucket binding');
    return { ...binding };
  }).sort((a,b) => a.name.localeCompare(b.name));
  requireThat(new Set(bindings.map(b => b.name)).size === bindings.length, 'Duplicate runtime bindings');
  const runtime = resources.script_runtime;
  keys(runtime, ['compatibility_date', 'usage_model', ...(runtime?.compatibility_flags === undefined ? [] : ['compatibility_flags']), ...(runtime?.limits === undefined ? [] : ['limits'])], 'Runtime configuration');
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(runtime.compatibility_date) && Array.isArray(runtime.compatibility_flags || []) && (runtime.compatibility_flags || []).every(f => typeof f === 'string'), 'Incomplete compatibility settings');
  requireThat(['standard','bundled','unbound'].includes(runtime.usage_model), 'Unsupported runtime usage model');
  requireThat((runtime.limits === undefined || (runtime.limits && typeof runtime.limits === 'object')) && Object.entries(runtime.limits || {}).every(([k,v]) => ['cpu_ms','subrequests'].includes(k) && Number.isInteger(v) && v > 0), 'Unsupported runtime limits');
  const script = resources.script;
  requireThat(typeof script?.etag === 'string' && script.etag.length > 0 && Array.isArray(script.handlers), 'Script content identity missing');
  requireThat(!script.placement_mode && !script.placement && !detail.cache_options?.enabled, 'Placement/cache runtime is not supported by artifact recovery');
  const supported = new Set(['etag','handlers','named_handlers','last_deployed_from','placement_mode','placement']);
  requireThat(Object.keys(script).every(k => supported.has(k)), 'Unknown script runtime metadata');
  return { bindings, script_runtime: runtime, script_etag: script.etag, handlers: script.handlers, named_handlers: script.named_handlers || [] };
}

export function latestFullDeployment(result) {
  const values = Array.isArray(result) ? result : result?.deployments;
  requireThat(Array.isArray(values) && values.length > 0, 'Deployment history missing');
  const ordered = [...values].sort((a,b) => Date.parse(b.created_on)-Date.parse(a.created_on));
  requireThat(ordered.every(d => uuid(d.id) && Number.isFinite(Date.parse(d.created_on))), 'Invalid deployment metadata');
  requireThat(ordered.length < 2 || Date.parse(ordered[0].created_on) > Date.parse(ordered[1].created_on), 'Ambiguous current deployment');
  const current = ordered[0];
  requireThat(current.versions?.length === 1 && uuid(current.versions[0].version_id) && current.versions[0].percentage === 100, 'Stable runtime must have exactly one version at 100 percent');
  return current;
}


// Public configuration historically sent through secret bulk is still public
// configuration. It must not accidentally inherit today's values during restore.
export function workflowBindingSources(workflow) {
  const privateNames = new Set([...workflow.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map(m=>m[1]));
  const publicNames = new Set([...workflow.matchAll(/--arg\s+([A-Z][A-Z0-9_]*)\s+"\$\{\{\s*vars\.[A-Z][A-Z0-9_]*(?:\s*\|\|\s*'[^']*')?\s*\}\}"/g)].map(m=>m[1]));
  return {privateNames,publicNames};
}
export function resolvePublicOpaqueBindings(descriptor, workflow, log) {
  const {privateNames,publicNames} = workflowBindingSources(workflow);
  const resolved = [];
  for (const binding of descriptor.bindings.filter(b=>b.type === 'secret_text')) {
    if (privateNames.has(binding.name)) continue;
    requireThat(publicNames.has(binding.name), `Opaque binding lacks classified pinned workflow provenance: ${binding.name}`);
    const expression = new RegExp('--arg\\s+' + binding.name + '\\s+"([^"\\r\\n]*)"', 'g');
    const values = new Set([...log.matchAll(expression)].map(m=>m[1]));
    requireThat(values.size === 1, `Resolved deployment log value missing or ambiguous: ${binding.name}`);
    const value = [...values][0];
    // Do not interpret shell expressions, escapes, masked data or substitutions.
    requireThat(!/[\\$`\r\n]/.test(value) && !value.includes('***'), `Resolved deployment log value is not a literal: ${binding.name}`);
    resolved.push({name:binding.name,type:'plain_text',text:value});
  }
  return resolved.sort((a,b)=>a.name.localeCompare(b.name));
}
export function redeployedRuntimeDescriptor(pkg) {
  return {...pkg.descriptor,bindings:pkg.descriptor.bindings.map(b=>pkg.resolved_nonsecret_bindings.find(r=>r.name===b.name) || b)};
}

export function validateRuntimePackage(pkg) {
  keys(pkg, ['schema_version','kind','main_module','modules','descriptor','secret_binding_policy','resolved_nonsecret_bindings'], 'Runtime package');
  requireThat(pkg.schema_version === 1 && pkg.kind === 'uk_aq_worker_runtime_package', 'Unsupported runtime package');
  requireThat(pkg.secret_binding_policy === 'preserve_current_required_bindings', 'Unsupported secret binding policy');
  const descriptor = runtimeDescriptor({ resources: { bindings: pkg.descriptor.bindings, script_runtime: pkg.descriptor.script_runtime, script: { etag: pkg.descriptor.script_etag, handlers: pkg.descriptor.handlers, named_handlers: pkg.descriptor.named_handlers } } });
  requireThat(runtimeJson(descriptor) === runtimeJson(pkg.descriptor), 'Runtime descriptor is not canonical');
  requireThat(Array.isArray(pkg.resolved_nonsecret_bindings) && new Set(pkg.resolved_nonsecret_bindings.map(b=>b.name)).size === pkg.resolved_nonsecret_bindings.length, 'Invalid resolved public binding inventory');
  for (const b of pkg.resolved_nonsecret_bindings) {
    keys(b,['name','type','text'],'Resolved public binding');
    requireThat(b.type === 'plain_text' && typeof b.text === 'string' && descriptor.bindings.some(original=>original.name === b.name && original.type === 'secret_text'), 'Resolved public binding is not an original opaque binding');
  }
  runtimeDescriptor({resources:{bindings:redeployedRuntimeDescriptor(pkg).bindings,script_runtime:descriptor.script_runtime,script:{etag:descriptor.script_etag,handlers:descriptor.handlers,named_handlers:descriptor.named_handlers}}});
  requireThat(Array.isArray(pkg.modules) && pkg.modules.length > 0 && pkg.modules.length <= 128, 'Invalid module inventory');
  const names = new Set(); let bytes = 0;
  for (const module of pkg.modules) {
    keys(module, ['name','content_type','body_base64','sha256'], 'Runtime module');
    requireThat(name(module.name) && module.name !== 'metadata' && !names.has(module.name), 'Unsafe or duplicate module name'); names.add(module.name);
    requireThat(['application/javascript+module','text/javascript+module','application/wasm','text/plain','application/octet-stream','application/source-map'].includes(module.content_type), 'Unsupported module content type');
    requireThat(typeof module.body_base64 === 'string' && module.body_base64.length <= 44 * 1024 * 1024, 'Oversized module');
    const body = Buffer.from(module.body_base64, 'base64'); bytes += body.length;
    requireThat(body.toString('base64') === module.body_base64 && sha(module.sha256) && runtimeSha(body) === module.sha256, 'Module physical byte identity mismatch');
  }
  requireThat(bytes <= 32 * 1024 * 1024 && names.has(pkg.main_module) && ['application/javascript+module','text/javascript+module'].includes(pkg.modules.find(m => m.name === pkg.main_module).content_type), 'Invalid main module or oversized package');
  return pkg;
}

export async function downloadRuntimeModules(response) {
  requireThat(response.ok && response.headers.get('content-type')?.startsWith('multipart/form-data'), 'Exact version module download failed or is not a module Worker');
  const main_module = response.headers.get('cf-entrypoint');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; requireThat(size <= 48 * 1024 * 1024, 'Runtime module response exceeds capture limit'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const raw = Buffer.concat(chunks);
  const form = await new Response(raw, {headers:{'content-type':response.headers.get('content-type')}}).formData();
  const modules = [];
  for (const [moduleName, file] of form.entries()) {
    requireThat(typeof file !== 'string' && typeof file.arrayBuffer === 'function', 'Module download contains unexpected metadata');
    const bytes = Buffer.from(await file.arrayBuffer());
    modules.push({name:moduleName, content_type:file.type, body_base64:bytes.toString('base64'), sha256:runtimeSha(bytes)});
  }
  return {main_module, modules:modules.sort((a,b)=>a.name.localeCompare(b.name))};
}

export function readRuntimePackage(component, repositoryRoot) {
  const location = component.recovery_package.path;
  requireThat(path.isAbsolute(location), 'Runtime package path must be absolute');
  const real = fs.realpathSync(location), root = fs.realpathSync(repositoryRoot);
  requireThat(real !== root && !real.startsWith(root + path.sep) && fs.statSync(real).size <= 48 * 1024 * 1024, 'Recovery package must be bounded and outside the Git working tree');
  const bytes = fs.readFileSync(real);
  requireThat(runtimeSha(bytes) === component.recovery_package.sha256, 'Recovery package SHA-256 mismatch');
  const pkg = validateRuntimePackage(JSON.parse(bytes));
  requireThat(runtimeSha(runtimeJson(pkg.descriptor)) === component.runtime_descriptor_sha256, 'Runtime descriptor identity mismatch');
  return pkg;
}

export function validateDurableRuntimeEvidence(evidence, repositoryRoot) {
  keys(evidence, ['schema_version','kind','payload','payload_sha256'], 'Runtime evidence');
  requireThat(evidence.schema_version === 2 && evidence.kind === RUNTIME_KIND && runtimeSha(runtimeJson(evidence.payload)) === evidence.payload_sha256, 'Invalid durable runtime evidence envelope');
  const p = evidence.payload;
  keys(p, ['environment','repository','branch','repository_head','recorded_at_utc','writers_frozen','history_version','index_authority_generation','integrity_version','components'], 'Durable runtime payload');
  requireThat(['TEST','LIVE'].includes(p.environment) && /^[\w.-]+\/[\w.-]+$/.test(p.repository) && name(p.branch) && gitSha(p.repository_head), 'Invalid runtime repository/environment identity');
  requireThat(p.history_version === 'v2' && p.index_authority_generation === 'v2' && p.integrity_version === 'v2', 'Capture must describe v2 authority');
  keys(p.writers_frozen, ['confirmed_at_utc','operator','resume_boundary'], 'Pre-plan freeze assertion');
  requireThat(typeof p.writers_frozen.operator === 'string' && p.writers_frozen.operator.trim() && p.writers_frozen.resume_boundary === 'accepted_v3_cutover_or_completed_v2_rollback', 'Missing continuous writer-freeze assertion');
  requireThat(Number.isFinite(Date.parse(p.recorded_at_utc)) && Number.isFinite(Date.parse(p.writers_frozen.confirmed_at_utc)) && Date.parse(p.writers_frozen.confirmed_at_utc) <= Date.parse(p.recorded_at_utc), 'Runtime was not captured after writer freeze');
  requireThat(Array.isArray(p.components) && p.components.length === 3 && runtimeJson(p.components.map(c=>c.role).sort()) === runtimeJson([...RUNTIME_ROLES].sort()), 'Incomplete runtime components');
  for (const c of p.components) {
    keys(c, ['role','worker_name','account_id','git_commit_sha','deployment','provenance','runtime_descriptor_sha256','recovery_package'], 'Runtime component');
    requireThat(/^[a-z0-9-]{1,63}$/.test(c.worker_name) && !c.worker_name.endsWith('-v3-candidate') && /^[a-f0-9]{32}$/.test(c.account_id) && gitSha(c.git_commit_sha), 'Invalid stable Worker identity');
    keys(c.deployment, ['version_id','deployment_id','captured_by'], 'Runtime deployment');
    requireThat(uuid(c.deployment.version_id) && uuid(c.deployment.deployment_id) && c.deployment.captured_by === 'version_specific_cloudflare_get', 'Invalid exact deployment identity');
    keys(c.provenance, ['workflow_run_id','workflow_path','workflow_sha256','git_tree_sha','package_lock_sha256'], 'Runtime source provenance');
    requireThat(/^[1-9][0-9]*$/.test(c.provenance.workflow_run_id) && name(c.provenance.workflow_path) && sha(c.provenance.workflow_sha256) && gitSha(c.provenance.git_tree_sha) && sha(c.provenance.package_lock_sha256), 'Invalid source provenance');
    keys(c.recovery_package, ['path','sha256'], 'Recovery package identity');
    requireThat(sha(c.recovery_package.sha256) && sha(c.runtime_descriptor_sha256), 'Invalid recovery package identity');
    const expectedWorkflow = {stable_observations_worker:'.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml',stable_station_worker:'.github/workflows/uk_aq_station_history_deploy.yml',cache_worker:'.github/workflows/uk_aq_cache_proxy_deploy.yml'}[c.role];
    requireThat(c.provenance.workflow_path === expectedWorkflow, 'Unexpected deployment workflow');
    const git = args => { const r = spawnSync('git',args,{cwd:repositoryRoot,maxBuffer:32*1024*1024}); requireThat(r.status === 0, 'Pinned runtime Git source unavailable'); return r.stdout; };
    requireThat(git(['rev-parse',`${c.git_commit_sha}^{tree}`]).toString().trim() === c.provenance.git_tree_sha, 'Pinned source tree mismatch');
    requireThat(runtimeSha(git(['cat-file','blob',`${c.git_commit_sha}:${expectedWorkflow}`])) === c.provenance.workflow_sha256, 'Pinned workflow blob mismatch');
    requireThat(runtimeSha(git(['cat-file','blob',`${c.git_commit_sha}:package-lock.json`])) === c.provenance.package_lock_sha256, 'Pinned package lock mismatch');
    const pkg = readRuntimePackage(c, repositoryRoot);
    const classification = workflowBindingSources(git(['cat-file','blob',`${c.git_commit_sha}:${expectedWorkflow}`]).toString());
    const publicOpaque = pkg.descriptor.bindings.filter(b=>b.type === 'secret_text' && !classification.privateNames.has(b.name));
    requireThat(publicOpaque.every(b=>classification.publicNames.has(b.name)) && runtimeJson(publicOpaque.map(b=>b.name).sort()) === runtimeJson(pkg.resolved_nonsecret_bindings.map(b=>b.name).sort()), 'Public opaque bindings lack exact pinned configuration or contain private values');
  }
  const observations = p.components.find(c=>c.role === 'stable_observations_worker');
  const observationsBindings = readRuntimePackage(observations, repositoryRoot).descriptor.bindings;
  const historyBinding = observationsBindings.find(b=>b.name === 'UK_AQ_R2_HISTORY_VERSION');
  requireThat(historyBinding?.type === 'plain_text' && historyBinding.text === 'v2', 'Captured observations runtime does not explicitly select v2');
  const cache = p.components.find(c=>c.role === 'cache_worker');
  const station = p.components.find(c=>c.role === 'stable_station_worker');
  const bindings = readRuntimePackage(cache, repositoryRoot).descriptor.bindings.filter(b=>b.name === 'STATION_HISTORY');
  requireThat(bindings.length === 1 && bindings[0].type === 'service' && bindings[0].service === station.worker_name, 'Captured cache does not bind stable station history');
  return {ok:true, kind:evidence.kind, payload_sha256:evidence.payload_sha256, environment:p.environment, repository:p.repository, branch:p.branch};
}

export function assertRuntimeRecordPin(authority, recordBytes, {allowLegacy = false} = {}) {
  requireThat(authority?.kind === 'uk_aq_index_v3_operator_authority' && [1,2].includes(authority.schema_version) && ['v2-to-v3','v3-rebuild'].includes(authority.transition), 'Ambiguous operator authority schema');
  keys(authority, ['schema_version','kind','environment','repository','branch','target_writer_git_sha','migration_run_id','transition','source_index_generation','target_index_generation','plan_sha256','inventory_root_sha256','state_root_sha256','v2_runtime_rollback_record_sha256','authority_sha256'], 'Operator authority');
  const {authority_sha256, ...payload} = authority;
  requireThat(runtimeSha(`${JSON.stringify(payload, null, 2)}\n`) === authority_sha256, 'Operator authority hash mismatch');
  requireThat(['TEST','LIVE'].includes(authority.environment) && authority.source_index_generation === (authority.transition === 'v2-to-v3' ? 'v2' : 'v3') && authority.target_index_generation === 'v3' && gitSha(authority.target_writer_git_sha) && [authority.plan_sha256,authority.inventory_root_sha256,authority.state_root_sha256].every(sha) && typeof authority.migration_run_id === 'string' && authority.migration_run_id.length > 0, 'Invalid operator migration identity');
  const pinned = authority.v2_runtime_rollback_record_sha256;
  if (authority.schema_version === 1 && authority.transition === 'v2-to-v3') {
    requireThat(pinned === null && allowLegacy, 'Unpinned v2-to-v3 authority is permitted only through explicit historical compatibility');
    return {legacy:true};
  }
  requireThat(sha(pinned) && recordBytes && runtimeSha(recordBytes) === pinned, 'Runtime rollback record differs from pinned operator authority');
  const record = JSON.parse(recordBytes);
  requireThat(record.kind === RUNTIME_KIND && record.payload?.environment === authority.environment && record.payload?.repository === authority.repository && record.payload?.branch === authority.branch, 'Pinned runtime environment/repository identity differs from operator authority');
  if (authority.schema_version === 2 && authority.transition === 'v2-to-v3') {
    requireThat(record.schema_version === 2, 'New v2-to-v3 authority requires durable runtime evidence schema 2');
    requireThat(record.payload.repository_head === authority.target_writer_git_sha, 'Fresh runtime capture HEAD differs from pinned target writer');
  }
  return {legacy:false};
}

// Publish without overwrite, including races between concurrent captures.
export function publishRuntimeFile(destination, bytes) {
  requireThat(!fs.existsSync(destination), 'Runtime authority output already exists');
  const temp = `${destination}.tmp-${crypto.randomUUID()}`;
  try { fs.writeFileSync(temp, bytes, {flag:'wx',mode:0o600}); fs.linkSync(temp,destination); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, authorityPath, recordPath, legacy] = process.argv.slice(2);
    if (mode !== 'validate-pin' || (legacy && legacy !== '--allow-legacy')) throw new Error('Usage: v2_runtime_artifact.mjs validate-pin AUTHORITY RECORD [--allow-legacy]');
    const result = assertRuntimeRecordPin(JSON.parse(fs.readFileSync(authorityPath)), recordPath && fs.existsSync(recordPath) ? fs.readFileSync(recordPath) : null, {allowLegacy:legacy === '--allow-legacy'});
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {process.stderr.write(error.message+'\n');process.exitCode=1;}
}
