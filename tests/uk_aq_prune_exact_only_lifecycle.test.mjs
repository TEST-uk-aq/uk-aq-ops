import './jsongen_test_environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { buildObservationHistoryV3SteadyStatePartition, createDormantPruneExactOnlyWriterV3,
  runPruneDailyObservationHistoryV3ConnectorPublication } from '../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs';
import { createObservationHistoryV3CanonicalConnectorPublisher, createObservationHistoryV3CanonicalDayPublisher,
  createObservationHistoryV3CanonicalAggregatePublisher } from '../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs';
import { buildObservationHistoryExactLeafIndexV3Latest, buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
  finalizeObservationHistoryIndexV3Publication, buildObservationHistoryIndexV3PublicationPlan }
  from '../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';
import { OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 } from '../workers/shared/uk_aq_observation_history_index_v3.mjs';
import { describeObservationHistoryExactOnlyCompletionV3 } from '../workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs';
import { computePruneConnectorSourceIdentity } from '../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest } from '../workers/shared/uk_aq_r2_history_canonical.mjs';
import { buildR2HistoryV2ObservationsRootManifest, buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsMonthManifest, serializeR2HistoryV2ObservationsAggregateManifest }
  from '../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';

const base = 'history/v3/observations', day = '2026-10-10', git = '4'.repeat(40);
const run = 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb';
const rows = ['pm25','no2'].flatMap((code,i) => {
  const row = { connector_id: 1, station_id: i+1, timeseries_id: i+1,
    pollutant_code: code, observed_at_utc: `${day}T01:02:03.004Z`, value: 1.25, verification_status: 'P' };
  return [row, {...row}];
});
const sourceIdentity = computePruneConnectorSourceIdentity(rows);
const inputs = () => ['pm25','no2'].map(code => ({ rows: rows.filter(r => r.pollutant_code === code) }));

function aggregates(dayManifest) {
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: base, year: 2026, month: '10', dayManifests: [dayManifest] });
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix: base, year: 2026, monthManifests: [month] });
  const root = buildR2HistoryV2ObservationsRootManifest({ basePrefix: base, yearManifests: [year] });
  return [month,year,root].map((p,i) => ({ key: `${base}/_manifests/${['year=2026/month=10/manifest.json','year=2026/manifest.json','manifest.json'][i]}`,
    body: serializeR2HistoryV2ObservationsAggregateManifest(p, { basePrefix: base }) }));
}

function fixture() {
  const objects = new Map(), versions = new Map(), writes = [], reads = [], assertions = [];
  let held = true, fault = null;
  const etag = key => `"${sha256Hex(objects.get(key))}-${versions.get(key) || 0}"`;
  const store = (key,body) => { objects.set(key,Buffer.from(body)); versions.set(key,(versions.get(key)||0)+1); };
  const build = r => buildObservationHistoryV3SteadyStatePartition({ source: 'prune_daily', rows: r,
    targetWriterGitSha: git, backedUpAtUtc: null });
  const prior = build([{...rows[0],connector_id:8,timeseries_id:9001}]);
  for (const a of [...prior.file_intents,prior.canonical_pollutant_manifest,...prior.v3_hierarchy.publication_objects]) store(a.key,a.body);
  const common = { domain:'observations',dayUtc:day,writerGitSha:git,backedUpAtUtc:null };
  const connector = buildHistoryV2ConnectorManifest({ ...common,connectorId:8,
    manifestKey:`${base}/day_utc=${day}/connector_id=8/manifest.json`,pollutantManifests:[prior.canonical_pollutant_manifest.payload] });
  const d = buildHistoryV2DayManifest({ ...common,manifestKey:`${base}/day_utc=${day}/manifest.json`,connectorManifests:[connector] });
  store(connector.manifest_key,JSON.stringify(connector)); store(d.manifest_key,JSON.stringify(d));
  for (const a of aggregates(d)) store(a.key,a.body);
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies:[prior.v3_hierarchy] }); store(latest.key,latest.body);
  const originalOperation = {run_id:run,async assertHeld(stage) { assertions.push(stage); if(!held) throw new Error('original session lost'); }};
  const getObject = async ({key}) => {
    reads.push(key); if(fault) await fault('get',key);
    const body = objects.get(key);
    return body ? {key,body,exists:true,bytes:body.length,etag:etag(key)} : {key,exists:false};
  };
  const headObject = async ({key}) => { const body=objects.get(key); return body ? {key,exists:true,bytes:body.length,sha256:sha256Hex(body),etag:etag(key)} : {key,exists:false}; };
  const putObject = async ({key,body}) => { if(fault) await fault('put',key); writes.push(key);store(key,body);return {key,etag:etag(key)}; };
  const r2 = {adapter:{ async putObjectConditional({key,body,if_match,if_none_match}) {
    if(fault) await fault('conditional_before',key);
    if((if_none_match==='*' && objects.has(key)) || (if_match && (!objects.has(key)||etag(key)!==if_match))) return {status:412};
    writes.push(key);store(key,body); const tag=etag(key);
    if(fault) await fault('conditional_after',key);
    return {status:200,etag:tag};
  }}};
  const putIfChanged = async a => { if(!objects.get(a.key)?.equals(Buffer.from(a.body))) await putObject(a);return {ok:true}; };
  const recordDurableEvidence = async a => { if(fault) await fault('durable',a.key); return {durable:true}; };
  const adapters = {getObject,putIfChanged,recordDurableEvidence,targetWriterGitSha:git};
  // The hierarchy finaliser expects native-style not-found exceptions.
  const hierarchyGet = async a => { const r=await getObject(a);if(!r.exists)throw Object.assign(new Error('NoSuchKey'),{status:404});return r; };
  const options = {client:{query:async()=>assert.fail('no PostgreSQL')},r2,originalOperation,
    getObject,headObject,putObject,putIfChanged,recordDurableEvidence,targetWriterGitSha:git,backedUpAtUtc:null,
    withConnectorDayLock:async(_o,fn)=>await fn(),runDayFinalizer:async o=>await o.finalize(),runGlobalFinalizer:async o=>await o.finalize(),
    publishConnectorScopedCanonicalManifests:createObservationHistoryV3CanonicalConnectorPublisher(adapters),
    finalizeCanonicalDayManifests:createObservationHistoryV3CanonicalDayPublisher(adapters),
    finalizeCanonicalAggregateManifests:createObservationHistoryV3CanonicalAggregatePublisher({r2,getObject:hierarchyGet,putObject,recordDurableEvidence,
      listAllCommonPrefixes:async({prefix})=>[...new Set([...objects.keys()].filter(k=>k.startsWith(prefix)).map(k=>prefix+k.slice(prefix.length).split('/')[0]+'/'))]}),
  };
  const writer=createDormantPruneExactOnlyWriterV3(options);
  return {writer,objects,writes,reads,options,store,build,latest,assertions,
    setFault:fn=>{fault=fn;},setHeld:value=>{held=value;},
    publish:()=>writer.publishConnector({partitions:inputs(),sourceIdentity}),
    resume:()=>writer.resumeConnector({dayUtc:day,connectorId:1,sourceIdentity}),
  };
}

test('actual connector -> checked batch publishes exact-only leaves/selectors/root/latest without a run report',async()=>{
  const f=fixture(); const publication=await f.publish();
  const results=publication.connector_results[0], scopes=results.exact_only_prepared_scopes;
  assert.equal(scopes.length,2);
  const firstSelector=Math.min(...scopes.map(s=>f.writes.indexOf(s.hierarchy.scoped_manifest.key)));
  assert.ok(scopes.every(s=>s.hierarchy.exact_leaves.every(l=>f.writes.indexOf(l.key)<firstSelector)));
  assert.equal(f.writes.filter(k=>k.includes('/_aligned/')).length,0);
  const fileReads=f.reads.filter(k=>k.endsWith('.parquet')).length;
  assert.equal(fileReads,2,'one independent actual-byte inspection per file');
  const completed=await f.writer.finalizeBatch();
  assert.equal(completed.ok,true);
  const description=await describeObservationHistoryExactOnlyCompletionV3(completed.exact_only_completions[0].completion);
  assert.equal(description.schema_version,2);assert.equal(description.scopes.reduce((n,s)=>n+s.row_count,0),4);
  assert.equal(f.reads.filter(k=>k.endsWith('.parquet')).length,fileReads,'batch reuses original physical proof');
  assert.ok(!f.writes.some(k=>k.includes('/_ops/')));
  assert.equal(description.authority_state,'prepared_before_original_gate_transaction');
  assert.ok(f.writes.indexOf(f.latest.key)>f.writes.indexOf(`${base}/_manifests/manifest.json`));
});

test('matching revision reuse and conflicting actual revision bytes',async()=>{
  for(const conflict of [false,true]) {
    const f=fixture(), p=f.build(rows.filter(r=>r.pollutant_code==='pm25')),m=p.canonical_pollutant_manifest;
    const h=buildObservationHistoryExactLeafIndexV3ScopedHierarchy({metadata:p.target_metadata,exactSchemaVersion:2,
      canonicalManifest:{key:m.key,byte_size:m.byte_size,sha256:m.sha256,manifest_hash:m.payload.manifest_hash,row_count:m.payload.row_count,
        observation_content_hash:m.payload.observation_content_hash,observation_content_hash_version:1}});
    const leaf=h.exact_leaves[0];f.store(leaf.key,conflict?Buffer.from('different'):leaf.body);
    if(conflict) {await assert.rejects(f.publish(),/bytes|immutable/);assert.ok(!f.writes.includes(h.scoped_manifest.key));}
    else {await f.publish();assert.ok(!f.writes.includes(leaf.key));await f.writer.finalizeBatch();}
  }
});

test('interrupted leaf/selector publication resumes under original operation without canonical rewrites',async()=>{
  for(const stage of ['leaf','selector']) {
    const f=fixture();let tripped=false;
    f.setFault(async(event,key)=>{if(!tripped&&event==='conditional_before'&&(stage==='leaf'?key.includes('/_exact_v2/'):key.endsWith('/manifest.json'))) {
      tripped=true;throw new Error('interrupted before write');
    }});
    await assert.rejects(f.publish()); await assert.rejects(f.writer.finalizeBatch(),/Incomplete/);
    const canonical=f.writes.filter(k=>k.startsWith(base));f.setFault(null);
    await f.resume();assert.deepEqual(f.writes.filter(k=>k.startsWith(base)),canonical);
    assert.equal((await f.writer.finalizeBatch()).ok,true);
  }
});

test('ambiguous successful conditional writes are reconciled by exact current readback',async()=>{
  const f=fixture();let faults=0;
  f.setFault(async(event)=>{if(event==='conditional_after'){faults++;throw new Error('lost response');}});
  await f.publish();assert.equal((await f.writer.finalizeBatch()).ok,true);assert.equal(faults,5);
});

test('changed predecessor and a selector replaced between GET and conditional PUT cannot select',async()=>{
  for(const race of [false,true]) {
    const f=fixture();let changed=false;
    f.setFault(async(event,key)=>{
      const selector=key.startsWith('history/_index_v3')&&key.endsWith('/manifest.json');
      if(!changed&&selector&&event===(race?'conditional_before':'get')) {
        // First GET is the original capture; alter it later, after canonical
        // writes, to exercise both the identity recheck and real CAS boundary.
        if(!f.writes.some(k=>k.endsWith('.parquet')))return;
        changed=true;f.store(key,Buffer.from('newer selector authority'));
      }
    });
    await assert.rejects(f.publish());
    assert.ok(changed);
    assert.ok(!f.writes.some(k=>k.startsWith('history/_index_v3')&&k.endsWith('/manifest.json')));
    await assert.rejects(f.writer.finalizeBatch(),/Incomplete/);
  }
});

test('lost selector readback resumes only the original written object; replacement ETag blocks recovery',async()=>{
  for(const replaced of [false,true]) {
    const f=fixture();let selectedKey=null,failed=false;
    f.setFault(async(event,key)=>{
      if(event==='conditional_after'&&key.endsWith('/manifest.json'))selectedKey=key;
      if(event==='get'&&key===selectedKey&&!failed){failed=true;throw new Error('readback unavailable');}
    });
    await assert.rejects(f.publish(),/readback unavailable/);
    f.setFault(null);const canonical=f.writes.filter(k=>k.startsWith(base));
    if(replaced){f.store(selectedKey,f.objects.get(selectedKey));await assert.rejects(f.resume(),/identity/);}
    else {await f.resume();}
    assert.deepEqual(f.writes.filter(k=>k.startsWith(base)),canonical);
    if(!replaced)assert.equal((await f.writer.finalizeBatch()).ok,true);
  }
});

test('selected parent with incomplete latest is not success; same-session batch retry finishes',async()=>{
  const f=fixture();await f.publish();
  f.setFault(async(event,key)=>{if(event==='conditional_before'&&key===f.latest.key)throw new Error('latest interrupted');});
  await assert.rejects(f.writer.finalizeBatch());
  const before=f.writes.filter(k=>k.includes('/_exact_v2/')||k.endsWith('/pollutant_code=pm25/manifest.json'));
  f.setFault(null);const r=await f.writer.finalizeBatch();assert.equal(r.ok,true);
  assert.deepEqual(f.writes.filter(k=>k.includes('/_exact_v2/')||k.endsWith('/pollutant_code=pm25/manifest.json')),before);
});

test('loss at a real canonical write boundary stops subsequent writes and cannot resume on a replacement session',async()=>{
  const f=fixture();
  f.setFault(async(event,key)=>{if(event==='put'&&key.endsWith('.parquet'))f.setHeld(false);});
  await assert.rejects(f.publish(),/session lost/);assert.equal(f.writes.length,1);
  f.setFault(null);f.setHeld(true);
  await assert.rejects(f.resume(),/session lost/);
  await assert.rejects(f.writer.finalizeBatch(),/session lost/);
  assert.equal(f.writes.length,1);
});

test('selector identity changes, newer latest, changed canonical files and original lock loss fail closed',async()=>{
  for(const mode of ['selector','file','lock','latest']) {
    const f=fixture();await f.publish();
    if(mode==='lock')f.setHeld(false);
    else if(mode==='file'){const key=f.writes.find(k=>k.endsWith('.parquet'));f.store(key,Buffer.from('new canonical'));
    } else if(mode==='selector'){const key=f.writes.find(k=>k.endsWith('/manifest.json')&&k.startsWith('history/_index_v3'));f.store(key,f.objects.get(key));
    } else {
      let tripped=false;f.setFault(async(event,key)=>{if(!tripped&&event==='conditional_before'&&key===f.latest.key){tripped=true;f.store(key,Buffer.from('newer latest'));}});
    }
    const before=f.writes.length;await assert.rejects(f.writer.finalizeBatch());
    if(mode!=='latest')assert.equal(f.writes.length,before);
  }
});

test('complete source admission, dormant boundary and normal schema-1 route retain guards',async()=>{
  const f=fixture();assert.equal(OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3,false);
  await assert.rejects(f.writer.publishConnector({partitions:inputs(),sourceIdentity:{...sourceIdentity,source_content_hash:'a'.repeat(64)}}),/source identity/);
  assert.equal(f.writes.length,0);
  assert.throws(()=>createDormantPruneExactOnlyWriterV3({...f.options,r2:{bucket:'native'}}),/isolated/);
  const p=await runPruneDailyObservationHistoryV3ConnectorPublication({...f.options,partitions:inputs(),exactSchemaVersion:2});
  assert.ok(p.connector_results[0].partitions.every(p=>p.scoped_root.artifact.payload.schema_version===1));
  assert.equal(f.reads.filter(k=>k.endsWith('.parquet')).length,0);
  const other=fixture();await other.publish();
  const prepared=other.build(rows.filter(r=>r.pollutant_code==='pm25')),m=prepared.canonical_pollutant_manifest;
  const h=buildObservationHistoryExactLeafIndexV3ScopedHierarchy({metadata:prepared.target_metadata,exactSchemaVersion:2,
    canonicalManifest:{key:m.key,byte_size:m.byte_size,sha256:m.sha256,manifest_hash:m.payload.manifest_hash,row_count:m.payload.row_count,
      observation_content_hash:m.payload.observation_content_hash,observation_content_hash_version:1}});
  const keys=new Set(h.publication_objects.map(a=>a.key));
  const external=h.publication_objects.flatMap(a=>[...a.publication_prerequisites||[],...a.dependencies||[]])
    .filter(r=>!keys.has(r.key)).map(r=>({...r,verified:true,durable:true}));
  const plan=buildObservationHistoryIndexV3PublicationPlan({objects:h.publication_objects,
    externalReferences:[...new Map(external.map(r=>[r.key,r])).values()]});
  await assert.rejects(finalizeObservationHistoryIndexV3Publication({plan,putIfChanged:()=>assert.fail(),getObject:()=>assert.fail(),recordDurableEvidence:()=>assert.fail()}),/inactive/);
});
