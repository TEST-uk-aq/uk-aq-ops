import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runtimeJson,runtimeSha,runtimeDescriptor,validateRuntimePackage,readRuntimePackage,validateDurableRuntimeEvidence,assertRuntimeRecordPin,publishRuntimeFile,resolvePublicOpaqueBindings,redeployedRuntimeDescriptor} from '../scripts/index_v3_migration/v2_runtime_artifact.mjs';
import {inspectArtifactRecovery,uploadPinnedRuntime} from '../scripts/index_v3_migration/v2_runtime_recovery.mjs';
import {main as capture, runtimeGet} from '../scripts/index_v3_migration/capture_v2_runtime_authority.mjs';
import {v2RuntimeAuthorityAdapters} from '../scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root});assert.equal(r.status,0);return r.stdout;};
const head=git('rev-parse','HEAD').toString().trim();
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const roles=['stable_observations_worker','stable_station_worker','cache_worker'];
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uk-aq-runtime-package-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const packages=new Map();
  const components=roles.map((role,i)=>{
    const bindings=[{type:'secret_text',name:'UK_AQ_EDGE_UPSTREAM_SECRET'},...(i===0?[{type:'plain_text',name:'UK_AQ_R2_HISTORY_VERSION',text:'v2'}]:[]),...(i===2?[{type:'service',name:'STATION_HISTORY',service:'worker-1'}]:[])];
    const descriptor=runtimeDescriptor({resources:{bindings,script_runtime:{compatibility_date:'2026-03-09',compatibility_flags:[],usage_model:'standard'},script:{etag:'exact-content',handlers:['fetch']}}});
    const body=Buffer.from('export default {fetch(){return new Response("v2")}}');
    const pkg=validateRuntimePackage({schema_version:1,kind:'uk_aq_worker_runtime_package',main_module:'worker.mjs',modules:[{name:'worker.mjs',content_type:'application/javascript+module',body_base64:body.toString('base64'),sha256:runtimeSha(body)}],descriptor,resolved_nonsecret_bindings:[],secret_binding_policy:'preserve_current_required_bindings'});
    const location=path.join(dir,`${i}.json`);publishRuntimeFile(location,runtimeJson(pkg));packages.set(role,pkg);
    const workflow=['.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml','.github/workflows/uk_aq_station_history_deploy.yml','.github/workflows/uk_aq_cache_proxy_deploy.yml'][i];
    return {role,worker_name:`worker-${i}`,account_id:'a'.repeat(32),git_commit_sha:head,deployment:{version_id:id(i+1),deployment_id:id(i+11),captured_by:'version_specific_cloudflare_get'},provenance:{workflow_run_id:String(i+101),workflow_path:workflow,workflow_sha256:runtimeSha(git('cat-file','blob',`${head}:${workflow}`)),git_tree_sha:git('rev-parse',`${head}^{tree}`).toString().trim(),package_lock_sha256:runtimeSha(git('cat-file','blob',`${head}:package-lock.json`))},runtime_descriptor_sha256:runtimeSha(runtimeJson(descriptor)),recovery_package:{path:location,sha256:runtimeSha(runtimeJson(pkg))}};
  });
  const payload={environment:'TEST',repository:'TEST-uk-aq/uk-aq-ops',branch:'main',repository_head:head,recorded_at_utc:'2026-09-06T10:01:00Z',writers_frozen:{confirmed_at_utc:'2026-09-06T10:00:00Z',operator:'fixture',resume_boundary:'accepted_v3_cutover_or_completed_v2_rollback'},history_version:'v2',index_authority_generation:'v2',integrity_version:'v2',components};
  return {dir,packages,components,evidence:{schema_version:2,kind:'uk_aq_index_v3_v2_runtime_rollback_record',payload,payload_sha256:runtimeSha(runtimeJson(payload))}};
}
function authority(record,{schema=2,pinned=runtimeSha(record)}={}) {
  const p={schema_version:schema,kind:'uk_aq_index_v3_operator_authority',environment:'TEST',repository:'TEST-uk-aq/uk-aq-ops',branch:'main',target_writer_git_sha:head,migration_run_id:'test-run',transition:'v2-to-v3',source_index_generation:'v2',target_index_generation:'v3',plan_sha256:'a'.repeat(64),inventory_root_sha256:'b'.repeat(64),state_root_sha256:'c'.repeat(64),v2_runtime_rollback_record_sha256:pinned};
  return {...p,authority_sha256:runtimeSha(`${JSON.stringify(p,null,2)}\n`)};
}
function detail(pkg,version,number=1) {return {id:version,number,resources:{bindings:pkg.descriptor.bindings,script_runtime:pkg.descriptor.script_runtime,script:{etag:pkg.descriptor.script_etag,handlers:pkg.descriptor.handlers,named_handlers:pkg.descriptor.named_handlers}}};}
function content(pkg) {const f=new FormData();for(const m of pkg.modules)f.set(m.name,new Blob([Buffer.from(m.body_base64,'base64')],{type:m.content_type}),m.name);const response=new Response(f);response.headers.set('cf-entrypoint',pkg.main_module);return response;}

test('new authority pins exact file bytes; ambiguous and unpinned new authority fail closed',t=>{
  const {evidence}=fixture(t),bytes=Buffer.from(runtimeJson(evidence));
  assert.equal(assertRuntimeRecordPin(authority(bytes),bytes).legacy,false);
  assert.throws(()=>assertRuntimeRecordPin(authority(bytes),Buffer.concat([bytes,Buffer.from(' ')])),/differs/);
  assert.throws(()=>assertRuntimeRecordPin(authority(bytes,{pinned:null}),bytes),/differs/);
  assert.throws(()=>assertRuntimeRecordPin(authority(bytes,{schema:3}),bytes),/Ambiguous/);
  const legacy=authority(bytes,{schema:1,pinned:null});
  assert.throws(()=>assertRuntimeRecordPin(legacy,bytes),/explicit historical/);
  assert.deepEqual(assertRuntimeRecordPin(legacy,bytes,{allowLegacy:true}),{legacy:true});
  assert.throws(()=>assertRuntimeRecordPin(authority(bytes,{schema:1}),bytes,{allowLegacy:true}),/explicit historical/);
});
test('durable evidence validates exact packages, Git provenance, v2 authority and freeze chronology',t=>{
  const f=fixture(t);assert.equal(validateDurableRuntimeEvidence(f.evidence,root).ok,true);
  const wrong=structuredClone(f.evidence);wrong.payload.writers_frozen.confirmed_at_utc='2026-09-06T10:02:00Z';wrong.payload_sha256=runtimeSha(runtimeJson(wrong.payload));
  assert.throws(()=>validateDurableRuntimeEvidence(wrong,root),/after writer freeze/);
  const wrongGit=structuredClone(f.evidence);wrongGit.payload.components[0].provenance.workflow_sha256='f'.repeat(64);wrongGit.payload_sha256=runtimeSha(runtimeJson(wrongGit.payload));assert.throws(()=>validateDurableRuntimeEvidence(wrongGit,root),/workflow blob mismatch/);
  fs.appendFileSync(f.components[0].recovery_package.path,' ');
  assert.throws(()=>validateDurableRuntimeEvidence(f.evidence,root),/package SHA-256 mismatch/);
});
test('immutable publication refuses overwrite and capture refuses an existing output before any API',async t=>{
  const f=fixture(t),out=path.join(f.dir,'evidence.json');publishRuntimeFile(out,'immutable');
  assert.throws(()=>publishRuntimeFile(out,'replacement'),/already exists/);
  t.mock.method(globalThis,'fetch',()=>{throw new Error('network must not be used');});
  await assert.rejects(capture(['capture-v2-runtime-rollback-authority','--environment','TEST','--work-dir',f.dir,'--out',out,'--operator','fixture','--confirm-frozen','--secret-binding-policy','preserve_current_required_bindings']),/already exists/);
  assert.equal(fs.readFileSync(out,'utf8'),'immutable');
});
test('package rejects secret values and unknown bindings; capture transport only issues GET',async t=>{
  const f=fixture(t),pkg=structuredClone(f.packages.get(roles[0]));pkg.descriptor.bindings.find(b=>b.type==='secret_text').text='do-not-save';
  assert.throws(()=>validateRuntimePackage(pkg),/unsupported fields/);
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.method,'GET');return new Response(JSON.stringify({success:true,result:{id:'read-only'}}));});
  assert.deepEqual(await runtimeGet({accountId:'test',apiToken:'fixture'},'worker','versions/id'),{id:'read-only'});
});
test('expired UUID admission requires verified durable material and does not upload or deploy',async t=>{
  const f=fixture(t);let mutations=0;
  const apiGet=async({workerName,suffix})=>{
    const c=f.components.find(c=>c.worker_name===workerName),pkg=f.packages.get(c.role);
    if(suffix==='deployments') return {deployments:[{id:id(30),created_on:'2026-09-06T11:00:00Z',versions:[{version_id:id(40),percentage:100}]}]};
    if(suffix===`versions/${c.deployment.version_id}`)return null;
    if(suffix==='versions')return {items:[{id:id(40),number:4}]};
    return detail(pkg,id(40),4);
  };
  const adapters=v2RuntimeAuthorityAdapters({rollbackEvidence:f.evidence,repositoryRoot:root,env:{UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN:'fixture',UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),UK_AQ_R2_CLOUDFLARE_API_TOKEN:'fixture'},apiGet,apiRequest:()=>{mutations++;throw new Error('no mutation allowed');},command:()=>{mutations++;}});
  const admission=await adapters.checkV2RuntimeRecoverability();assert.ok(admission.components.every(c=>c.state==='deterministic_pinned_runtime_redeploy_available' && c.selected_version_id===null));assert.equal(mutations,0);
  fs.unlinkSync(f.components[0].recovery_package.path);
  await assert.rejects(adapters.checkV2RuntimeRecoverability(),/unrecoverable/);assert.equal(mutations,0);
});
test('artifact upload uses only pinned bytes/configuration and strict named secret inheritance',async t=>{
  const f=fixture(t),component=f.components[0],pkg=f.packages.get(component.role);let uploaded=false;const requests=[];
  const get=async(c,suffix)=>suffix==='versions'?{items:[{id:uploaded?id(50):id(40),number:uploaded?5:4}]}:detail(pkg,uploaded?id(50):id(40),uploaded?5:4);
  const request=async(c,suffix,options)=>{
    requests.push([suffix,options.method]);
    if(options.method==='GET')return content(pkg);
    assert.equal(suffix,'versions?bindings_inherit=strict');
    const metadata=JSON.parse(options.body.get('metadata'));
    assert.deepEqual(metadata.bindings.find(b=>b.name==='UK_AQ_EDGE_UPSTREAM_SECRET'),{name:'UK_AQ_EDGE_UPSTREAM_SECRET',type:'inherit'});
    assert.equal(Buffer.from(await options.body.get('worker.mjs').arrayBuffer()).toString('base64'),pkg.modules[0].body_base64);
    uploaded=true;return {id:id(50)};
  };
  assert.equal(await uploadPinnedRuntime({component,repositoryRoot:root,get,request}),id(50));
  assert.deepEqual(requests.map(r=>r[1]),['POST','GET']);assert.ok(requests.every(([p])=>!p.includes('deployments')));
});
test('secret-name drift and intervening uploads cannot authorize artifact deployment',async t=>{
  const f=fixture(t),component=f.components[0],pkg=f.packages.get(component.role);
  const bad=detail(pkg,id(40),4);bad.resources.bindings=[];
  await assert.rejects(inspectArtifactRecovery({component,repositoryRoot:root,get:async(c,s)=>s==='versions'?{items:[{id:id(40),number:4}]}:bad}),/secret binding inventory/);
  let uploaded=false;
  const get=async(c,s)=>s==='versions'?{items:[{id:uploaded?id(50):id(40),number:uploaded?6:4}]}:detail(pkg,uploaded?id(50):id(40),uploaded?6:4);
  await assert.rejects(uploadPinnedRuntime({component,repositoryRoot:root,get,request:async(c,s,o)=>{if(o.method==='GET')return content(pkg);uploaded=true;return {id:id(50)};}}),/Concurrent runtime upload/);
});

test('successful capture uses version-specific GETs, pins packages and refuses later overwrite',async t=>{
  const f=fixture(t),bin=path.join(f.dir,'bin');fs.mkdirSync(bin);
  const variables={UKAQ_ENV_NAME:'TEST',UK_AQ_R2_HISTORY_VERSION:'v2',UK_AQ_R2_HISTORY_INDEX_VERSION:'v2',UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME:'worker-0',UK_AQ_STATION_HISTORY_WORKER_NAME:'worker-1',UK_AQ_CACHE_WORKER_NAME:'worker-2'};
  const script=`#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nconst vars=${JSON.stringify(variables)}, components=${JSON.stringify(f.components)};\nlet result;\nif(args[0]==='variable' && args[1]==='get') result=vars[args[2]];\nelse if(args[0]==='api' && args[1]==='graphql') result={data:{repository:{nameWithOwner:'TEST-uk-aq/uk-aq-ops',defaultBranchRef:{name:'main',target:{oid:${JSON.stringify(head)}}}}}};\nelse if(args[0]==='api'){const c=components.find(c=>args[1].endsWith('/'+c.provenance.workflow_run_id));if(!c)process.exit(2);result={status:'completed',conclusion:'success',path:c.provenance.workflow_path,head_branch:'main',head_sha:c.git_commit_sha,repository:{full_name:'TEST-uk-aq/uk-aq-ops'}};}\nelse if(args[0]==='run' && args[1]==='view'){const c=components.find(c=>c.provenance.workflow_run_id===args[2]);result='Current Version ID: '+c.deployment.version_id;}\nelse process.exit(2);\nif(result===undefined)process.exit(2);process.stdout.write(typeof result==='string'?result:JSON.stringify(result));\n`;
  fs.writeFileSync(path.join(bin,'gh'),script,{mode:0o700});
  // Ignore this task's deliberate dirty tree only in the fixture; all other Git
  // evidence reads still use the real immutable objects. No fixture commits.
  fs.writeFileSync(path.join(bin,'git'),`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args[0]==='status')process.exit(0);const r=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(r.status);\n`,{mode:0o700});
  const oldPath=process.env.PATH;process.env.PATH=bin+path.delimiter+oldPath;t.after(()=>{process.env.PATH=oldPath;});
  const gets=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.method,'GET');gets.push(String(url));
    const c=f.components.find(c=>String(url).includes('/'+c.worker_name+'/'));assert.ok(c);
    if(String(url).includes('/content/v2?version=')){assert.ok(String(url).endsWith(c.deployment.version_id));return content(f.packages.get(c.role));}
    const result=String(url).endsWith('/deployments')?{deployments:[{id:c.deployment.deployment_id,created_on:'2026-09-06T00:00:00Z',versions:[{version_id:c.deployment.version_id,percentage:100}]}]}:detail(f.packages.get(c.role),c.deployment.version_id);
    return new Response(JSON.stringify({success:true,result}));
  });
  const out=path.join(f.dir,'captured.json'),args=['capture-v2-runtime-rollback-authority','--environment','TEST','--work-dir',f.dir,'--out',out,'--operator','fixture','--confirm-frozen','--secret-binding-policy','preserve_current_required_bindings','--observations-run-id','101','--station-run-id','102','--cache-run-id','103'];
  await capture(args,{UKAQ_ENV_NAME:'TEST',UK_AQ_R2_HISTORY_INTEGRITY_VERSION:'v2',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'fixture-token'});
  const record=JSON.parse(fs.readFileSync(out));assert.equal(validateDurableRuntimeEvidence(record,root).ok,true);
  assert.equal(gets.filter(p=>p.includes('/content/')).length,6);
  assert.ok(record.payload.components.every(c=>fs.existsSync(c.recovery_package.path)));
  const before=gets.length;await assert.rejects(capture(args),/already exists/);assert.equal(gets.length,before);
});

test('raw fresh migration refuses an unpinned start before any external call',async t=>{
  const {runObservationHistoryMigrationV3}=await import('../scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs');
  t.mock.method(globalThis,'fetch',()=>{throw new Error('must not contact API');});
  await assert.rejects(runObservationHistoryMigrationV3({argv:['--mode','migrate','--transition','v2-to-v3','--apply','--writers-frozen','--checkpoint-out','not-created.json','--expected-plan-sha256','a'.repeat(64)]}),/Fresh migration requires/);
  assert.equal(fs.existsSync(path.join(root,'not-created.json')),false);
});

test('public settings stored as secret text require exact logged literals and never inherit current values',t=>{
  const f=fixture(t),pkg=structuredClone(f.packages.get(roles[1]));
  pkg.descriptor.bindings.push({name:'SUPABASE_URL',type:'secret_text'});
  const workflow='--arg SUPABASE_URL "${{ vars.SUPABASE_URL }}" --arg UK_AQ_EDGE_UPSTREAM_SECRET "${{ secrets.UK_AQ_EDGE_UPSTREAM_SECRET }}"';
  assert.throws(()=>resolvePublicOpaqueBindings(pkg.descriptor,workflow,''),/missing or ambiguous/);
  assert.throws(()=>resolvePublicOpaqueBindings(pkg.descriptor,workflow,'--arg SUPABASE_URL "${TODAYS_URL}"'),/not a literal/);
  pkg.resolved_nonsecret_bindings=resolvePublicOpaqueBindings(pkg.descriptor,workflow,'--arg SUPABASE_URL "https://accepted.example"');
  assert.deepEqual(redeployedRuntimeDescriptor(pkg).bindings.find(b=>b.name==='SUPABASE_URL'),{name:'SUPABASE_URL',type:'plain_text',text:'https://accepted.example'});
  assert.deepEqual(redeployedRuntimeDescriptor(pkg).bindings.find(b=>b.name==='UK_AQ_EDGE_UPSTREAM_SECRET'),{name:'UK_AQ_EDGE_UPSTREAM_SECRET',type:'secret_text'});
});
