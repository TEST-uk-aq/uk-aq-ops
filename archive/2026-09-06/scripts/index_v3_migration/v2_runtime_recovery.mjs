// Artifact recovery is separate from the legacy UUID-only authority path.
import {runtimeJson, runtimeDescriptor, readRuntimePackage, downloadRuntimeModules, validateRuntimePackage, redeployedRuntimeDescriptor} from './v2_runtime_artifact.mjs';

function ensure(ok,message) {if(!ok) throw new Error(message);}
function secrets(descriptor) {return descriptor.bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort();}
function latestVersion(result) {
  const values=Array.isArray(result)?result:result?.items;
  ensure(Array.isArray(values) && values.length>0 && values.every(v=>Number.isInteger(v.number)), 'Latest runtime version chronology unavailable');
  const ordered=[...values].sort((a,b)=>b.number-a.number);
  ensure(ordered.length<2 || ordered[0].number>ordered[1].number,'Ambiguous latest version');
  return ordered[0];
}
export async function inspectArtifactRecovery({component,repositoryRoot,get}) {
  const pkg=readRuntimePackage(component,repositoryRoot);
  const latest=latestVersion(await get(component,'versions'));
  const detail=await get(component,`versions/${encodeURIComponent(latest.id)}`);
  ensure(detail.id===latest.id && detail.number===latest.number,'Latest runtime version identity mismatch');
  // Names alone never establish historical secret value identity. This route is
  // valid only under the explicit policy sealed into the future package.
  const bindings=detail.resources?.bindings;
  ensure(Array.isArray(bindings),'Current secret binding inventory unavailable');
  const actual=bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort();
  ensure(new Set(actual).size===actual.length && secrets(redeployedRuntimeDescriptor(pkg)).every(n=>actual.includes(n)) && actual.every(n=>secrets(pkg.descriptor).includes(n)), 'Current required secret binding inventory differs from pinned recovery policy');
  return {pkg,latest};
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
export async function verifyArtifactRuntime({component,versionId,repositoryRoot,get,request}) {
  const pkg=readRuntimePackage(component,repositoryRoot);
  const detail=await get(component,`versions/${encodeURIComponent(versionId)}`);
  ensure(detail.id===versionId && runtimeJson(runtimeDescriptor(detail))===runtimeJson(versionId===component.deployment.version_id?pkg.descriptor:redeployedRuntimeDescriptor(pkg)),'Restored runtime configuration/content descriptor differs from pinned package');
  const content=await downloadRuntimeModules(await request(component,`content/v2?version=${encodeURIComponent(versionId)}`,{method:'GET',raw:true}));
  ensure(runtimeJson(content)===runtimeJson({main_module:pkg.main_module,modules:pkg.modules}),'Restored runtime module bytes differ from pinned package');
  return detail;
}
export async function uploadPinnedRuntime({component,repositoryRoot,get,request}) {
  const {pkg,latest}=await inspectArtifactRecovery({component,repositoryRoot,get});
  validateRuntimePackage(pkg);
  const metadata={main_module:pkg.main_module,...pkg.descriptor.script_runtime,bindings:redeployedRuntimeDescriptor(pkg).bindings.map(b=>b.type==='secret_text'?{name:b.name,type:'inherit'}:b)};
  const form=new FormData();
  form.set('metadata',JSON.stringify(metadata));
  for(const module of pkg.modules) form.set(module.name,new Blob([Buffer.from(module.body_base64,'base64')],{type:module.content_type}),module.name);
  // This is called only by the existing admitted, authorized rollback executor.
  // It uploads captured bytes directly: no build, mutable workflow or Git checkout.
  const uploaded=await request(component,'versions?bindings_inherit=strict',{method:'POST',body:form});
  ensure(typeof uploaded?.id==='string' && uploaded.id!==component.deployment.version_id,'Runtime artifact upload did not produce a new version');
  process.stderr.write(`Runtime artifact uploaded: role=${component.role} historical_version=${component.deployment.version_id} new_version=${uploaded.id} package_sha256=${component.recovery_package.sha256} (not yet deployed)\n`);
  const detail=await verifyArtifactRuntime({component,versionId:uploaded.id,repositoryRoot,get,request});
  // Inheritance is from the immediately preceding upload. Refuse deployment if
  // another version intervened, even when its secret names happen to be equal.
  ensure(detail.number===latest.number+1,'Concurrent runtime upload invalidated secret inheritance provenance');
  const newest=latestVersion(await get(component,'versions'));
  ensure(newest.id===uploaded.id && newest.number===detail.number,'Runtime changed during artifact upload');
  return uploaded.id;
}
