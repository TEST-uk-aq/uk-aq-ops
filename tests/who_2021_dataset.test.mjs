import test from 'node:test';
import assert from 'node:assert/strict';
import { backupDataset, runWhoDatasetOperation } from '../scripts/who_2021/dataset.mjs';
import { resolveWho2021Prefix, whoRelativeKey } from '../workers/shared/uk_aq_who_2021_storage.mjs';

test('WHO roots and scoped keys reject fallback, traversal and mismatched family', () => {
  for (const value of [undefined,'','/who_2021','https://bucket/who_2021','history/../who_2021','bucket','who_2021//']) {
    assert.throws(()=>resolveWho2021Prefix({UK_AQ_WHO_2021_R2_PREFIX:value}));
  }
  for (const value of ['who_2021','history/v2/who_2021/']) {
    const root=resolveWho2021Prefix({UK_AQ_WHO_2021_R2_PREFIX:value});
    assert.equal(whoRelativeKey(root,root+'latest_who_2021.json'),'latest_who_2021.json');
    assert.throws(()=>whoRelativeKey(root,root+'daily_status/../../observations/part-00000.parquet'));
  }
});

test('snapshot verifies destination and completes last; changed source keeps prior selector', async () => {
  const originalFetch=globalThis.fetch;
  const env={UK_AQ_ENV_NAME:'TEST',CFLARE_R2_ENDPOINT:'https://r2.example.invalid',CFLARE_R2_BUCKET:'unit-test-bucket',CFLARE_R2_ACCESS_KEY_ID:'fixture',CFLARE_R2_SECRET_ACCESS_KEY:'fixture',UK_AQ_WHO_2021_R2_PREFIX:'history/v2/who_2021',UK_AQ_WHO_2021_BACKUP_WRITER_EXCLUSION_CONFIRMED:'true',UK_AQ_DROPBOX_ROOT:'fixture',DROPBOX_APP_KEY:'fixture',DROPBOX_APP_SECRET:'fixture',DROPBOX_REFRESH_TOKEN:'fixture'};
  const payload=JSON.stringify({data_as_of_day_utc:'2026-07-02',cards:[]});
  const files=new Map(),writes=[]; let changed=false,changeOnUpload=false,corruptDownload=false;
  globalThis.fetch=async (url,options={}) => {
    const u=new URL(url);
    if(u.hostname==='r2.example.invalid') {
      if(u.searchParams.has('list-type')) return new Response(`<ListBucketResult><Name>unit-test-bucket</Name><Prefix>history/v2/who_2021/</Prefix><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>history/v2/who_2021/latest_who_2021.json</Key><Size>${Buffer.byteLength(payload)}</Size><ETag>&quot;${changed?'changed':'original'}&quot;</ETag></Contents></ListBucketResult>`);
      return new Response(payload,{headers:{etag:'"'+(changed?'changed':'original')+'"','content-type':'application/json'}});
    }
    if(u.pathname.endsWith('/token')) return Response.json({access_token:'fixture'});
    const arg=JSON.parse(options.headers['Dropbox-API-Arg']);
    if(u.pathname.endsWith('/download')) return files.has(arg.path)?new Response(corruptDownload?'bad':files.get(arg.path)):new Response('',{status:404});
    if(u.pathname.endsWith('/upload')) {
      const body=Buffer.from(options.body);
      if(arg.mode==='add' && files.has(arg.path)) return new Response('',{status:409});
      files.set(arg.path,body);writes.push(arg.path);
      if(changeOnUpload) changed=true;
      return Response.json({});
    }
    throw new Error('Unexpected mocked transport');
  };
  try {
    const result=await backupDataset(env);
    assert.equal(result.status,'complete');assert.equal(result.object_count,1);
    const selector='/fixture/who_2021/datasets/latest-complete.json';
    assert.equal(writes.at(-1),selector);
    assert.match(writes.at(-2),/\/complete.json$/);assert.match(writes.at(-3),/\/manifest.json$/);
    const previous=files.get(selector).toString();
    const restore=await runWhoDatasetOperation(env,{mode:'restore',snapshot:result.snapshot_id,approve:result.manifest_sha256,'confirm-bucket':env.CFLARE_R2_BUCKET});
    assert.equal(restore.status,'validated_no_writes');assert.match(restore.target,/^who_2021_restore\//);
    await assert.rejects(runWhoDatasetOperation(env,{mode:'restore',snapshot:result.snapshot_id,approve:'wrong','confirm-bucket':env.CFLARE_R2_BUCKET}),/completion identity mismatch/);
    changeOnUpload=true;
    await assert.rejects(backupDataset(env),/source changed/);
    assert.equal(files.get(selector).toString(),previous);
    changed=false;changeOnUpload=false;corruptDownload=true;
    await assert.rejects(backupDataset(env),/destination verification failed/);
    assert.equal(files.get(selector).toString(),previous);
  } finally {globalThis.fetch=originalFetch;}
});

test('summary reader separates roots even when ETags coincide', async () => {
  const {handleWhoSummaryUpstreamRequest}=await import('../workers/uk_aq_observs_history_r2_api_worker/who_summary_route.mjs');
  const previous=globalThis.caches, cache=new Map(),reads=[];
  globalThis.caches={default:{match:async r=>cache.get(r.url)?.clone(),put:async(r,v)=>{cache.set(r.url,v.clone());}}};
  const request=new Request('https://unit.invalid/v1/who-summary?as_of=2026-07-02',{headers:{'x-uk-aq-upstream-auth':'fixture'}});
  const env={UK_AQ_EDGE_UPSTREAM_SECRET:'fixture',UK_AQ_WHO_2021_R2_PREFIX:'history/v2/who_2021/',UK_AQ_HISTORY_BUCKET:{get:async(key,options)=>{
    reads.push({key,options});
    return options?{etag:'same-etag'}:{etag:'same-etag',body:true,text:async()=>JSON.stringify({data_as_of_day_utc:'2026-07-02',cards:[],source:key})};
  }}};
  try {
    assert.equal((await handleWhoSummaryUpstreamRequest(request,env)).status,200);
    env.UK_AQ_WHO_2021_R2_PREFIX='who_2021/';
    const moved=await handleWhoSummaryUpstreamRequest(request,env);
    assert.equal((await moved.json()).source,'who_2021/latest_who_2021.json');
    assert.equal(reads[1].options,undefined);assert.equal(cache.size,2);
    const hit=await handleWhoSummaryUpstreamRequest(request,env);
    assert.equal(hit.headers.get('X-UK-AQ-WHO-Origin-Cache'),'HIT_VALIDATED');
    env.UK_AQ_WHO_2021_R2_PREFIX='';
    assert.equal((await handleWhoSummaryUpstreamRequest(request,env)).status,500);
    assert.equal(reads.length,3);
  } finally {if(previous===undefined) delete globalThis.caches;else globalThis.caches=previous;}
});
