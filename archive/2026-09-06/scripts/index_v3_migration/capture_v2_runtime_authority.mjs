#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {superviseOperatorInvocation, withOperatorPhase} from './operator_execution.mjs';
import {assertCleanWorkingTree, cloudflareCaptureCredentials, parseWorkflowVersionId} from './index_v3_capture_operator_evidence.mjs';
import {RUNTIME_KIND, runtimeJson, runtimeSha, runtimeDescriptor, latestFullDeployment, downloadRuntimeModules, validateRuntimePackage, validateDurableRuntimeEvidence, publishRuntimeFile, readRuntimePackage, assertRuntimeRecordPin, resolvePublicOpaqueBindings} from './v2_runtime_artifact.mjs';

const DEFINITIONS = [
  ['stable_observations_worker','UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME','observations','.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml','observations-run-id'],
  ['stable_station_worker','UK_AQ_STATION_HISTORY_WORKER_NAME','domain','.github/workflows/uk_aq_station_history_deploy.yml','station-run-id'],
  ['cache_worker','UK_AQ_CACHE_WORKER_NAME','domain','.github/workflows/uk_aq_cache_proxy_deploy.yml','cache-run-id'],
];
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(command,args,cwd=root) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024,timeout:60000});
  if(result.status!==0) throw new Error(`${command} read-only evidence query failed`);
  return result.stdout.trim();
}
function gitBytes(commit,file) {
  const r=spawnSync('git',['cat-file','blob',`${commit}:${file}`],{cwd:root,maxBuffer:32*1024*1024});
  if(r.status!==0) throw new Error('Pinned Git blob unavailable'); return r.stdout;
}
export async function runtimeGet(credentials, worker, suffix, {raw=false, allowMissing=false}={}) {
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/workers/scripts/${encodeURIComponent(worker)}/${suffix}`,{method:'GET',headers:{Authorization:`Bearer ${credentials.apiToken}`},signal:AbortSignal.timeout(60000)});
  if(raw) return response;
  const body=await response.json().catch(()=>null);
  if(allowMissing && response.status===404 && body?.errors?.some(e=>e.code===100146)) return null;
  if(!response.ok || body?.success!==true) throw new Error(`Read-only Cloudflare runtime GET failed: HTTP ${response.status}`);
  return body.result;
}
function options(argv) {
  const args={};
  const flags=new Set(['environment','work-dir','out','operator','observations-run-id','station-run-id','cache-run-id','evidence','secret-binding-policy','operator-authority-file']);
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--confirm-frozen') {args.confirmFrozen=true;continue;}
    const key=argv[i].slice(2);
    if(!argv[i].startsWith('--') || !flags.has(key) || !argv[i+1] || argv[i+1].startsWith('--') || args[key]) throw new Error(`Invalid capture option: ${argv[i]}`);
    args[key]=argv[++i];
  }
  return args;
}
async function context(environment,env) {
  if(!['TEST','LIVE'].includes(environment) || environment!==env.UKAQ_ENV_NAME?.toUpperCase()) throw new Error('Explicit --environment must match loaded UKAQ_ENV_NAME');
  assertCleanWorkingTree(root);
  // Load at command execution, not module evaluation: the rollback authenticator
  // itself loads the migration CLI while authenticating historical recovery.
  const {validateRollbackReviewedHead}=await import('./rollback_executor_authority.mjs');
  const identity=validateRollbackReviewedHead({repositoryRoot:root});
  const variable=name=>run('gh',['variable','get',name,'--repo',identity.repository]);
  if(variable('UKAQ_ENV_NAME').toUpperCase()!==environment) throw new Error('GitHub environment mismatch');
  if(env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION!=='v2') throw new Error('Loaded UK_AQ_R2_HISTORY_INTEGRITY_VERSION must be v2');
  for(const name of ['UK_AQ_R2_HISTORY_VERSION','UK_AQ_R2_HISTORY_INDEX_VERSION']) if(variable(name)!=='v2') throw new Error(`GitHub ${name} must be v2`);
  return {identity,variable,credentials:cloudflareCaptureCredentials(env)};
}
export async function verifyCurrentRuntimeEvidence(evidence, environment, env=process.env, pinnedAuthority=null) {
  validateDurableRuntimeEvidence(evidence,root);
  const {identity,variable,credentials}=await context(environment,env), p=evidence.payload;
  if(p.environment!==environment || p.repository!==identity.repository || p.branch!==identity.branch) throw new Error('Fresh runtime evidence repository/default HEAD mismatch');
  if(pinnedAuthority) {
    if(pinnedAuthority.schema_version!==2 || pinnedAuthority.transition!=='v2-to-v3' || pinnedAuthority.target_writer_git_sha!==p.repository_head || pinnedAuthority.repository!==p.repository || pinnedAuthority.environment!==p.environment || pinnedAuthority.branch!==p.branch) throw new Error('Capture identity differs from pinned migration authority');
  } else if(p.repository_head!==identity.local_head) throw new Error('Fresh capture must match current reviewed HEAD');
  for(const [role,workerVariable,account] of DEFINITIONS) {
    const c=p.components.find(c=>c.role===role), auth=credentials[account];
    if(c.worker_name!==variable(workerVariable) || c.account_id!==auth.accountId) throw new Error('Stable Worker/account identity mismatch');
    const current=latestFullDeployment(await runtimeGet(auth,c.worker_name,'deployments'));
    if(current.id!==c.deployment.deployment_id || current.versions[0].version_id!==c.deployment.version_id) throw new Error('Stable runtime changed since capture; do not repin a started migration');
    const detail=await runtimeGet(auth,c.worker_name,`versions/${c.deployment.version_id}`);
    if(detail.id!==c.deployment.version_id || runtimeJson(runtimeDescriptor(detail))!==runtimeJson(readRuntimePackage(c,root).descriptor)) throw new Error('Current runtime descriptor differs from captured authority');
    const pkg=readRuntimePackage(c,root);
    const content=await downloadRuntimeModules(await runtimeGet(auth,c.worker_name,`content/v2?version=${c.deployment.version_id}`,{raw:true}));
    if(runtimeJson(content)!==runtimeJson({main_module:pkg.main_module,modules:pkg.modules})) throw new Error('Captured module bytes differ from the exact current version');
    const runId=c.provenance.workflow_run_id;
    const workflowRun=JSON.parse(run('gh',['api',`repos/${identity.repository}/actions/runs/${runId}`]));
    if(workflowRun.status!=='completed' || workflowRun.conclusion!=='success' || workflowRun.head_sha!==c.git_commit_sha || workflowRun.path!==c.provenance.workflow_path || workflowRun.head_branch!==p.branch || workflowRun.repository?.full_name!==p.repository) throw new Error('Captured workflow provenance differs from GitHub');
    const log=run('gh',['run','view',runId,'--repo',identity.repository,'--log']);
    if(parseWorkflowVersionId(log,role)!==c.deployment.version_id || runtimeJson(resolvePublicOpaqueBindings(pkg.descriptor,gitBytes(c.git_commit_sha,c.provenance.workflow_path).toString(),log))!==runtimeJson(pkg.resolved_nonsecret_bindings)) throw new Error('Captured public configuration differs from exact deployment provenance');
    const after=latestFullDeployment(await runtimeGet(auth,c.worker_name,'deployments'));
    if(after.id!==current.id || after.versions[0].version_id!==c.deployment.version_id) throw new Error('Runtime changed during capture verification');

  }
  return {ok:true, current_stable_v2_runtime:true, durable_packages_verified:true, mutation_calls:0};
}
export async function main(argv=process.argv.slice(2),env=process.env) {
  const [mode,...rest]=argv;
  if(mode==='--help') {process.stdout.write('capture-v2-runtime-rollback-authority --environment TEST|LIVE --work-dir DIR --out FILE --operator NAME --confirm-frozen --secret-binding-policy preserve_current_required_bindings --observations-run-id ID --station-run-id ID --cache-run-id ID\nverify-current --environment TEST|LIVE --evidence FILE\n');return;}
  if(!['capture-v2-runtime-rollback-authority','verify-current'].includes(mode)) throw new Error('Unknown runtime authority operation');
  const args=options(rest);
  if(mode==='verify-current') {
    const bytes=fs.readFileSync(args.evidence);
    const authority=args['operator-authority-file']?JSON.parse(fs.readFileSync(args['operator-authority-file'])):null;
    if(authority) assertRuntimeRecordPin(authority,bytes);
    const result=await verifyCurrentRuntimeEvidence(JSON.parse(bytes),args.environment,env,authority);
    process.stdout.write(JSON.stringify(result)+'\n');return;
  }
  if(!args.confirmFrozen || !args.operator?.trim()) throw new Error('Capture requires --operator and --confirm-frozen covering every manual and scheduled mutation class until cutover or completed rollback');
  if(args['secret-binding-policy']!=='preserve_current_required_bindings') throw new Error('Capture requires an explicit supported secret binding policy');
  const frozen=new Date().toISOString();
  if(!args.out || !args['work-dir']) throw new Error('--out and --work-dir are required');
  const directory=fs.realpathSync(args['work-dir']), destination=path.join(fs.realpathSync(path.dirname(path.resolve(args.out))),path.basename(args.out));
  if(directory===fs.realpathSync(root) || directory.startsWith(fs.realpathSync(root)+path.sep) || path.dirname(destination)!==directory) throw new Error('Authority output must be directly in --work-dir, outside the Git working tree');
  if(fs.existsSync(destination)) throw new Error('Runtime authority output already exists; capture never overwrites');
  const {identity,variable,credentials}=await context(args.environment,env);
  const p={environment:args.environment,repository:identity.repository,branch:identity.branch,repository_head:identity.local_head,recorded_at_utc:null,writers_frozen:{confirmed_at_utc:frozen,operator:args.operator,resume_boundary:'accepted_v3_cutover_or_completed_v2_rollback'},history_version:'v2',index_authority_generation:'v2',integrity_version:'v2',components:[]};
  for(const [role,workerVariable,account,workflow,runFlag] of DEFINITIONS) await withOperatorPhase(`Capture runtime: ${role}`,async()=>{
    const worker=variable(workerVariable), auth=credentials[account];
    if(!/^[a-z0-9-]{1,63}$/.test(worker) || worker.endsWith('-v3-candidate')) throw new Error('Capture resolved an invalid stable Worker name');
    const runId=args[runFlag];
    if(!/^[1-9][0-9]*$/.test(runId||'')) throw new Error(`--${runFlag} is required`);
    const workflowRun=JSON.parse(run('gh',['api',`repos/${identity.repository}/actions/runs/${runId}`]));
    if(workflowRun.status!=='completed' || workflowRun.conclusion!=='success' || workflowRun.path!==workflow || workflowRun.head_branch!==identity.branch || workflowRun.repository?.full_name!==identity.repository) throw new Error('Runtime deployment workflow provenance mismatch');
    const log=run('gh',['run','view',runId,'--repo',identity.repository,'--log']);
    const version=parseWorkflowVersionId(log,role);
    const deployment=latestFullDeployment(await runtimeGet(auth,worker,'deployments'));
    if(deployment.versions[0].version_id!==version) throw new Error('Workflow UUID is not the exact current stable runtime; Git/timestamp proximity is insufficient');
    const detail=await runtimeGet(auth,worker,`versions/${version}`);
    if(detail.id!==version) throw new Error('Cloudflare version response mismatch');
    const descriptor=runtimeDescriptor(detail);
    const resolved=resolvePublicOpaqueBindings(descriptor,gitBytes(workflowRun.head_sha,workflow).toString(),log);
    const pkg=validateRuntimePackage({schema_version:1,kind:'uk_aq_worker_runtime_package',...await downloadRuntimeModules(await runtimeGet(auth,worker,`content/v2?version=${version}`,{raw:true})),descriptor,resolved_nonsecret_bindings:resolved,secret_binding_policy:args['secret-binding-policy']});
    const bytes=runtimeJson(pkg), digest=runtimeSha(bytes), packagePath=path.join(directory,`${path.basename(destination)}.${role}.${digest}.package.json`);
    if(fs.existsSync(packagePath)) {if(runtimeSha(fs.readFileSync(packagePath))!==digest) throw new Error('Existing package identity mismatch');}
    else publishRuntimeFile(packagePath,bytes);
    const commit=workflowRun.head_sha;
    p.components.push({role,worker_name:worker,account_id:auth.accountId,git_commit_sha:commit,deployment:{version_id:version,deployment_id:deployment.id,captured_by:'version_specific_cloudflare_get'},provenance:{workflow_run_id:runId,workflow_path:workflow,workflow_sha256:runtimeSha(gitBytes(commit,workflow)),git_tree_sha:run('git',['rev-parse',`${commit}^{tree}`]),package_lock_sha256:runtimeSha(gitBytes(commit,'package-lock.json'))},runtime_descriptor_sha256:runtimeSha(runtimeJson(pkg.descriptor)),recovery_package:{path:packagePath,sha256:digest}});
  });
  p.recorded_at_utc=new Date().toISOString();
  const evidence={schema_version:2,kind:RUNTIME_KIND,payload:p,payload_sha256:runtimeSha(runtimeJson(p))};
  await verifyCurrentRuntimeEvidence(evidence,args.environment,env);
  publishRuntimeFile(destination,runtimeJson(evidence));
  process.stdout.write(JSON.stringify({ok:true,out:destination,payload_sha256:evidence.payload_sha256,mutation_calls:0,scheduler_state_proved:false})+'\n');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(!process.env.UK_AQ_OPERATOR_SUPERVISED && process.argv[2]!=='--help') process.exitCode=await superviseOperatorInvocation(fileURLToPath(import.meta.url),process.argv.slice(2));
    else await main();
  } catch(error) {process.stderr.write(`Runtime authority: ${error.message}\n`);process.exitCode=1;}
}
