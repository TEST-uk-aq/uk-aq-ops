// Artifact recovery is separate from the legacy UUID-only authority path.
import {runtimeJson, runtimeDescriptor, readRuntimePackage, downloadRuntimeModules, validateRuntimePackage, redeployedRuntimeDescriptor, latestFullDeployment} from './v2_runtime_artifact.mjs';

function ensure(ok,message) {if(!ok) throw new Error(message);}
function secrets(descriptor) {return descriptor.bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort();}
const versionIdIsValid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function latestVersion(result) {
  const values=Array.isArray(result)?result:result?.items;
  ensure(Array.isArray(values) && values.length>0 && values.every(v=>Number.isSafeInteger(v.number) && v.number > 0 && versionIdIsValid(v.id)), 'Latest runtime version chronology unavailable');
  const ordered=[...values].sort((a,b)=>b.number-a.number);
  ensure(ordered.length<2 || ordered[0].number>ordered[1].number,'Ambiguous latest version');
  return ordered[0];
}
export async function inspectArtifactRecovery({component,repositoryRoot,runtimeEvidencePath,get}) {
  const pkg=readRuntimePackage(component,repositoryRoot,runtimeEvidencePath);
  const deployed=latestFullDeployment(await get(component,'deployments'));
  const sourceVersionId=deployed.versions[0].version_id;
  const detail=await get(component,`versions/${encodeURIComponent(sourceVersionId)}`);
  ensure(detail?.id===sourceVersionId,'Deployed runtime version identity mismatch');
  // Names alone never establish historical secret value identity. This route is
  // valid only under the explicit policy sealed into the future package.
  const bindings=detail.resources?.bindings;
  ensure(Array.isArray(bindings),'Current secret binding inventory unavailable');
  const actual=bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort();
  ensure(new Set(actual).size===actual.length && secrets(redeployedRuntimeDescriptor(pkg)).every(n=>actual.includes(n)) && actual.every(n=>secrets(pkg.descriptor).includes(n)), 'Current required secret binding inventory differs from pinned recovery policy');
  return {
    pkg,
    secret_inheritance_source_version_id: sourceVersionId,
    secret_inheritance_source_deployment_id: deployed.id,
  };
}
async function assertSecretInheritanceSource({component,source,get}) {
  ensure(versionIdIsValid(source?.secret_inheritance_source_version_id) && versionIdIsValid(source?.secret_inheritance_source_deployment_id), 'Artifact upload requires the admitted deployed secret source');
  const current=latestFullDeployment(await get(component,'deployments'));
  ensure(current.id===source.secret_inheritance_source_deployment_id && current.versions[0].version_id===source.secret_inheritance_source_version_id, 'Current deployment changed since secret inheritance admission');
}

export async function assertArtifactDeploymentReady({component,versionId,source,get}) {
  await assertSecretInheritanceSource({component,source,get});
  const latest=latestVersion(await get(component,'versions'));
  ensure(latest.id===versionId, 'Concurrent runtime upload detected before artifact deployment');
}

export async function workerRuntimeRequest({accountId,apiToken,workerName,suffix,method,body,raw=false}) {
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/${suffix}`, {
    method,headers:{Authorization:`Bearer ${apiToken}`,...(typeof body==='string'?{'Content-Type':'application/json'}:{})},body,signal:AbortSignal.timeout(60000),
  });
  if(raw) return response;
  const result=await response.json().catch(()=>null);
  ensure(response.ok && result?.success===true,`Cloudflare runtime ${method} failed: HTTP ${response.status}`);
  return result.result;
}
export async function verifyArtifactRuntime({component,versionId,repositoryRoot,runtimeEvidencePath,get,request}) {
  const pkg=readRuntimePackage(component,repositoryRoot,runtimeEvidencePath);
  const detail=await get(component,`versions/${encodeURIComponent(versionId)}`);
  ensure(detail.id===versionId && runtimeJson(runtimeDescriptor(detail))===runtimeJson(versionId===component.deployment.version_id?pkg.descriptor:redeployedRuntimeDescriptor(pkg)),'Restored runtime configuration/content descriptor differs from pinned package');
  const content=await downloadRuntimeModules(await request(component,`content/v2?version=${encodeURIComponent(versionId)}`,{method:'GET',raw:true}));
  ensure(runtimeJson(content)===runtimeJson({main_module:pkg.main_module,modules:pkg.modules}),'Restored runtime module bytes differ from pinned package');
  return detail;
}
export async function uploadPinnedRuntime({component,repositoryRoot,runtimeEvidencePath,source,get,request}) {
  // Admission chooses the currently deployed version; never replace that choice
  // with a more recent upload or silently re-admit a changed deployment.
  await assertSecretInheritanceSource({component,source,get});
  const inspected=await inspectArtifactRecovery({component,repositoryRoot,runtimeEvidencePath,get});
  ensure(inspected.secret_inheritance_source_version_id===source.secret_inheritance_source_version_id && inspected.secret_inheritance_source_deployment_id===source.secret_inheritance_source_deployment_id, 'Current deployment changed since secret inheritance admission');
  const {pkg}=inspected;
  validateRuntimePackage(pkg);
  const metadata={main_module:pkg.main_module,...pkg.descriptor.script_runtime,bindings:redeployedRuntimeDescriptor(pkg).bindings.map(b=>b.type==='secret_text'?{name:b.name,type:'inherit',version_id:source.secret_inheritance_source_version_id}:b)};
  const form=new FormData();
  form.set('metadata',JSON.stringify(metadata));
  for(const module of pkg.modules) form.set(module.name,new Blob([Buffer.from(module.body_base64,'base64')],{type:module.content_type}),module.name);
  // This is called only by the existing admitted, authorized rollback executor.
  // It uploads captured bytes directly: no build, mutable workflow or Git checkout.
  const latest=latestVersion(await get(component,'versions'));
  await assertSecretInheritanceSource({component,source,get});
  const uploaded=await request(component,'versions?bindings_inherit=strict',{method:'POST',body:form});
  ensure(versionIdIsValid(uploaded?.id) && uploaded.id!==component.deployment.version_id && uploaded.id!==latest.id,'Runtime artifact upload did not produce a new version');
  process.stderr.write(`Runtime artifact uploaded: role=${component.role} historical_version=${component.deployment.version_id} new_version=${uploaded.id} package_sha256=${component.recovery_package.sha256} (not yet deployed)\n`);
  const detail=await verifyArtifactRuntime({component,versionId:uploaded.id,repositoryRoot,runtimeEvidencePath,get,request});
  // The latest upload is only a creation chronology guard. Secret inheritance
  // explicitly references the admitted deployed version, even when it is older.
  ensure(detail.number===latest.number+1,'Concurrent runtime upload invalidated version creation chronology');
  const newest=latestVersion(await get(component,'versions'));
  ensure(newest.id===uploaded.id && newest.number===detail.number,'Runtime changed during artifact upload');
  return uploaded.id;
}
