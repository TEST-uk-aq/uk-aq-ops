// Independent WHO dataset operations. Importing this module performs no I/O.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parquetMetadata } from 'hyparquet';
import { buildAwsSignedRequest, r2ListObjectsV2 } from '../../workers/shared/r2_sigv4.mjs';
import { resolveHistoryBackupR2 } from '../backup_r2/lib/history_backup_targets.mjs';
import { resolveWho2021Prefix, whoRelativeKey } from '../../workers/shared/uk_aq_who_2021_storage.mjs';

const MAX_OBJECTS = 10000, MAX_OBJECT = 8 * 1024 ** 2, MAX_TOTAL = 64 * 1024 ** 2;
const hash = b => createHash('sha256').update(b).digest('hex');
const json = x => Buffer.from(JSON.stringify(x) + '\n');
const fail = message => { throw new Error(message); };
const required = (env, key) => String(env[key] || '').trim() || fail('Missing ' + key);
const safePath = x => typeof x === 'string' && /^[a-zA-Z0-9_./=-]+$/.test(x) && x.split('/').every(p => p && p !== '.' && p !== '..');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const etag = x => String(x || '').replace(/^"|"$/g, '');
const order = x => x.relative === 'latest_who_2021.json' ? 2 : x.relative.startsWith('summaries/') ? 1 : 0;
const sorted = a => [...a].sort((a,b) => order(a)-order(b) || a.relative.localeCompare(b.relative));
function exclusion(env) {
  if (env.UK_AQ_WHO_2021_BACKUP_WRITER_EXCLUSION_CONFIRMED !== 'true') fail('WHO writer exclusion must be confirmed, including manual writers');
}
async function bounded(response, max = MAX_OBJECT) {
  if (!response.ok) fail('Remote request failed: HTTP ' + response.status);
  const chunks=[]; let size=0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size>max) { await response.body?.cancel().catch(()=>{}); fail('WHO byte budget exceeded'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function request(url, init) {
  // Retry reads and idempotent writes only. No credentials or signed URLs in errors.
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const r = await fetch(url, {...init, signal: AbortSignal.timeout(30000)});
      if (![408,429,500,502,503,504].includes(r.status) || attempt===2) return r;
      await r.body?.cancel();
    } catch { if (attempt===2) fail('WHO remote transport failed; inspect partial operation before retry'); }
    await new Promise(r=>setTimeout(r, 250*(attempt+1)));
  }
}
function metadata(headers) {
  return Object.fromEntries([...headers].filter(([k]) => k.startsWith('x-amz-meta-') || ['content-type','cache-control','content-disposition','content-language','expires'].includes(k)).sort(([a],[b])=>a.localeCompare(b)));
}
async function r2Request(r2, method, key, body, headers={}) {
  const q=buildAwsSignedRequest({method, endpoint:r2.endpoint, region:r2.region, accessKeyId:r2.access_key_id, secretAccessKey:r2.secret_access_key, bucket:r2.bucket, objectKey:key, payloadHash:hash(body || Buffer.alloc(0)), headers});
  return request(q.url,{method,headers:q.headers,...(body?{body}: {})});
}
async function get(r2,key) {
  const r=await r2Request(r2,'GET',key);
  if (r.headers.get('content-encoding') && r.headers.get('content-encoding')!=='identity') fail('Encoded WHO objects require a separately reviewed exact-byte transport');
  const body=await bounded(r);
  return {body,sha256:hash(body),size:body.length,etag:r.headers.get('etag'),metadata:metadata(r.headers)};
}
async function inventory(r2,prefix) {
  const entries=[], tokens=new Set(); let token=null;
  do {
    const p=await r2ListObjectsV2({r2,prefix,continuation_token:token,max_keys:1000,require_valid_listing:true});
    for (const x of p.entries) {
      const relative=whoRelativeKey(prefix,x.key);
      if (!Number.isSafeInteger(x.size)||x.size<0||x.size>MAX_OBJECT||!etag(x.etag)) fail('Invalid WHO inventory identity/budget');
      entries.push({key:x.key,relative,size:x.size,etag:etag(x.etag)});
    }
    token=p.next_token;
    if (token && tokens.has(token)) fail('Repeated listing continuation token');
    tokens.add(token);
    if (entries.length>MAX_OBJECTS) fail('WHO object budget exceeded');
  } while(token);
  entries.sort((a,b)=>a.key.localeCompare(b.key));
  if (new Set(entries.map(x=>x.key)).size!==entries.length || entries.reduce((n,x)=>n+x.size,0)>MAX_TOTAL) fail('Invalid/oversized WHO listing');
  return entries;
}
function validateBody(relative,body) {
  if (relative.endsWith('.json')) {
    const d=JSON.parse(body.toString('utf8'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.data_as_of_day_utc)||!Array.isArray(d.cards)) fail('Invalid WHO summary body');
    const refs=[];
    function visit(x) {
      if (typeof x==='string' && /(?:history\/v2\/)?who_2021\//.test(x)) refs.push(x);
      else if (Array.isArray(x)) x.forEach(visit);
      else if (x && typeof x==='object') Object.values(x).forEach(visit);
    }
    visit(d);
    // No current WHO payload requires absolute output references. Never silently
    // move one: transforms would change exact-byte restoration/scientific evidence.
    if (refs.length) fail('Embedded WHO output references require an explicitly reviewed transformation');
  } else {
    const array=body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength);
    const m=parquetMetadata(array);
    if (!m.schema?.length || Number(m.num_rows)<=0) fail('Invalid/empty WHO Parquet');
  }
}
async function capture(env) {
  exclusion(env);
  const r2=resolveHistoryBackupR2(env), prefix=resolveWho2021Prefix(env);
  const before=await inventory(r2,prefix);
  if (!before.length) fail('Empty WHO dataset');
  const objects=[]; const start=Date.now();
  for (const x of before) {
    if (Date.now()-start>20*60*1000) fail('WHO capture time budget exceeded');
    const v=await get(r2,x.key);
    if (v.size!==x.size||etag(v.etag)!==x.etag) fail('WHO source changed during capture');
    validateBody(x.relative,v.body);objects.push({...x,...v});
  }
  if (!same(before,await inventory(r2,prefix))) fail('WHO inventory changed during capture');
  return {r2,prefix,objects};
}
async function verifySource(c) {
  for (const x of c.objects) {
    const v=await get(c.r2,x.key);
    if (v.sha256!==x.sha256||!same(v.metadata,x.metadata)||etag(v.etag)!==etag(x.etag)) fail('WHO source changed after capture');
  }
  const now=await inventory(c.r2,c.prefix);
  if (!same(now,c.objects.map(({key,relative,size,etag:e})=>({key,relative,size,etag:etag(e)})))) fail('WHO inventory changed after transfer');
}
function dropboxRoot(env) {
  const root=required(env,'UK_AQ_DROPBOX_ROOT').replace(/^\/+|\/+$/g,'');
  if (!safePath(root)) fail('Invalid Dropbox root');
  return '/'+root+'/who_2021/datasets';
}
async function dropbox(env) {
  const auth=await request('https://api.dropboxapi.com/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:required(env,'DROPBOX_REFRESH_TOKEN'),client_id:required(env,'DROPBOX_APP_KEY'),client_secret:required(env,'DROPBOX_APP_SECRET')})});
  const token=JSON.parse((await bounded(auth,1024*1024)).toString()).access_token;
  if (!token) fail('Dropbox token response invalid');
  const headers={Authorization:'Bearer '+token};
  return {
    async read(path) { const r=await request('https://content.dropboxapi.com/2/files/download',{method:'POST',headers:{...headers,'Dropbox-API-Arg':JSON.stringify({path})}});return bounded(r); },
    async write(path,body,overwrite=false) {
      const r=await request('https://content.dropboxapi.com/2/files/upload',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Dropbox-API-Arg':JSON.stringify({path,mode:overwrite?'overwrite':'add',autorename:false,mute:true,strict_conflict:true})},body});
      if (r.status!==409) await bounded(r,1024*1024); else await r.body?.cancel();
      // A conflict/ambiguous retry is acceptable only for exact existing bytes.
      if (hash(await this.read(path))!==hash(body)) fail('Dropbox destination verification failed');
    }
  };
}
function manifest(c,id) {
  return {schema_version:1,status:'complete',snapshot_id:id,bucket:c.r2.bucket,prefix:c.prefix,object_count:c.objects.length,total_bytes:c.objects.reduce((n,x)=>n+x.size,0),coverage:['daily_status','rolling_year_status','calendar_year_status','summaries'].map(f=>({family:f,count:c.objects.filter(x=>x.relative.startsWith(f+'/')).length})),objects:c.objects.map(({body,...x})=>x)};
}
export async function backupDataset(env=process.env) {
  const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
  let phase='capture';
  try {
    const c=await capture(env), db=await dropbox(env),root=dropboxRoot(env);
    const base=root+'/snapshots/'+id;
    phase='object_copy';
    for (const x of sorted(c.objects)) await db.write(base+'/objects/'+x.relative,x.body);
    phase='source_revalidation';
    await verifySource(c);
    const m=manifest(c,id),bytes=json(m),sha256=hash(bytes);
    phase='manifest_and_completion';
    await db.write(base+'/manifest.json',bytes);
    const completion=json({schema_version:1,snapshot_id:id,manifest_sha256:sha256});
    await db.write(base+'/complete.json',completion);
    phase='latest_selector';
    await db.write(root+'/latest-complete.json',completion,true);
    return {status:'complete',snapshot_id:id,manifest_sha256:sha256,object_count:m.object_count,total_bytes:m.total_bytes,source_prefix:c.prefix};
  } catch (error) {
    error.datasetBackup={status:'failed_or_partial',snapshot_id:id,phase};
    throw error;
  }
}

async function verifiedPut(r2,key,x) {
  const response=await r2Request(r2,'PUT',key,x.body,{...x.metadata,'if-none-match':'*'});
  if (!response.ok && response.status!==412) fail('R2 conditional create failed: HTTP '+response.status);
  await response.body?.cancel();
  const v=await get(r2,key);
  if (v.sha256!==x.sha256||!same(v.metadata,x.metadata)) fail('R2 destination bytes/metadata differ; no overwrite attempted');
}
async function restore(env,args) {
  exclusion(env);
  const r2=resolveHistoryBackupR2(env),db=await dropbox(env),root=dropboxRoot(env);
  if (typeof args.snapshot !== 'string' || !/^[0-9TZ-]+-[0-9a-f-]{36}$/.test(args.snapshot)) fail('Invalid snapshot ID');
  const base=root+'/snapshots/'+args.snapshot;
  const selector=JSON.parse((await db.read(base+'/complete.json')).toString());
  if (selector.schema_version!==1||selector.snapshot_id!==args.snapshot||selector.manifest_sha256!==args.approve) fail('Snapshot completion identity mismatch');
  const bytes=await db.read(base+'/manifest.json');
  if (hash(bytes)!==args.approve) fail('Snapshot manifest hash mismatch');
  const m=JSON.parse(bytes.toString());
  if (m.schema_version!==1||m.status!=='complete'||m.snapshot_id!==args.snapshot||m.bucket!==r2.bucket||!Array.isArray(m.objects)||m.objects.length!==m.object_count||!m.object_count||m.object_count>MAX_OBJECTS) fail('Invalid snapshot manifest');
  const prefix=resolveWho2021Prefix({UK_AQ_WHO_2021_R2_PREFIX:m.prefix});
  const target='who_2021_restore/'+randomUUID()+'/who_2021/';
  let total=0;const seen=new Set();const objects=[];
  for (const x of m.objects) {
    if (whoRelativeKey(prefix,x.key)!==x.relative||seen.has(x.relative)||!Number.isSafeInteger(x.size)||x.size<0||x.size>MAX_OBJECT||!x.metadata||Object.keys(x.metadata).some(k=>!(k.startsWith('x-amz-meta-')||['content-type','cache-control','content-disposition','content-language','expires'].includes(k)))) fail('Invalid snapshot member');
    seen.add(x.relative);total+=x.size;if (total>MAX_TOTAL) fail('Restore byte budget exceeded');
    const body=await db.read(base+'/objects/'+x.relative);
    if (body.length!==x.size||hash(body)!==x.sha256) fail('Restore byte hash mismatch');
    validateBody(x.relative,body);objects.push({...x,body});
  }
  if (total!==m.total_bytes) fail('Restore total mismatch');
  if (args.execute!=='true') return {status:'validated_no_writes',target,object_count:objects.length,total_bytes:total};
  for (const x of sorted(objects)) await verifiedPut(r2,target+x.relative,x);
  return {status:'isolated_restore_verified',target,object_count:objects.length,total_bytes:total};
}
export async function runWhoDatasetOperation(env,args) {
  if (args.mode==='backup') {
    if (args.execute!=='true') fail('Backup writes Dropbox: explicitly pass --execute true under separate approval');
    return backupDataset(env);
  }
  if (env.UK_AQ_ENV_NAME!=='TEST'||args['confirm-bucket']!==required(env,'CFLARE_R2_BUCKET')||args['confirm-bucket']!==resolveHistoryBackupR2(env).bucket) fail('TEST environment and explicit configured bucket confirmation required');
  if (args.mode==='restore') return restore(env,args);
  const target=resolveWho2021Prefix({UK_AQ_WHO_2021_R2_PREFIX:args.target});
  const c=await capture(env);
  if (target===c.prefix||target.startsWith(c.prefix)||c.prefix.startsWith(target)) fail('Overlapping WHO source/destination');
  const m={...manifest(c,'migration-plan'),target_prefix:target};
  const bytes=json(m),sha256=hash(bytes);
  if (args.mode==='plan') {
    if ((await inventory(c.r2,target)).length) fail('WHO destination collision');
    if (!args.manifest) fail('Required --manifest output path');
    await writeFile(args.manifest,bytes,{flag:'wx',mode:0o600});return {status:'planned_no_remote_writes',manifest_sha256:sha256,object_count:m.object_count,total_bytes:m.total_bytes};
  }
  if (args.mode!=='copy'||args.execute!=='true'||!args.manifest||!args.approve) fail('Unknown mode or missing explicit copy approval');
  const approved=await readFile(args.manifest);
  if (hash(approved)!==args.approve||!same(JSON.parse(approved.toString()),m)) fail('Approved plan differs from current source');
  const expected=new Set(c.objects.map(x=>target+x.relative));
  if ((await inventory(c.r2,target)).some(x=>!expected.has(x.key))) fail('Unexpected destination objects');
  for (const x of sorted(c.objects)) await verifiedPut(c.r2,target+x.relative,x);
  await verifySource(c);
  return {status:'copy_verified_old_root_retained',manifest_sha256:args.approve,object_count:m.object_count,total_bytes:m.total_bytes};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args={};
  try {
    for(let i=2;i<process.argv.length;i+=2) {
      const k=process.argv[i].replace(/^--/,'');
      if (!['mode','execute','confirm-bucket','target','manifest','approve','snapshot','report'].includes(k)||args[k]||!process.argv[i+1]) fail('Invalid/duplicate CLI option');
      args[k]=process.argv[i+1];
    }
    const result=await runWhoDatasetOperation(process.env,args);
    if(args.report) await writeFile(args.report,json(result),{flag:'wx',mode:0o600});
    console.log(JSON.stringify(result));
  } catch(error) {
    const result={status:'failed_or_partial',message:String(error.message).slice(0,500),...(error.datasetBackup?{dataset_backup:error.datasetBackup}:{})};
    if(args.report) await writeFile(args.report,json(result),{flag:'wx',mode:0o600}).catch(()=>{});
    console.error(JSON.stringify(result));process.exitCode=1;
  }
}
