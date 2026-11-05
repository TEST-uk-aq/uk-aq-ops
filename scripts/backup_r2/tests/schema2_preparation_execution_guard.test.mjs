import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { requireNoSchema2PreparationExecution } from "../lib/schema2_preparation_execution_guard.mjs";
import { applyValidatedGenericV3Proposal } from "../uk_aq_apply_generic_v3_proposal.mjs";
import { applyValidatedSosLightV3Proposal } from "../uk_aq_apply_sos_light_v3_proposal.mjs";
import { parseSchema2DiagnosticArgs } from "../uk_aq_schema2_read_only_diagnostic.mjs";

const contract = "uk_aq_integrity_v3_schema2_preparation_v1";
const attempts = [
  { schema2_preparation: null },
  { schema2_preparation: { contract_version: contract, state: "prepared_only" } },
  { objects: { ordinaryKey: { preparation_contract_version: contract } } },
  { planning: { status: "planned", proposals: [{ contract_version: contract, state: "prepared_only" }] } },
];

test("Stage 2M diagnostic selection cannot accept write arguments; real Python selection and outer scratch cleanup are separate from repair", () => {
  const args = ["--admit-only", "--handoff-json", "/tmp/input.json", "--sha256", "a".repeat(64), "--bytes", "10", "--result-json", "/tmp/result.json"];
  assert.equal(parseSchema2DiagnosticArgs(args).mode, "--admit-only");
  for (const changed of [[...args, "--write-r2"], ["--write-r2", ...args.slice(1)], ["--run-state-json", ...args.slice(1)]]) {
    assert.throws(() => parseSchema2DiagnosticArgs(changed), /no write mode/);
  }
  const source = new URL("../../uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py", import.meta.url);
  const result = spawnSync("python3", ["-c", String.raw`
import argparse, ast, contextlib, datetime as dt, io, json, os, re, sys, tempfile, shutil, subprocess, time, signal
from pathlib import Path
from types import SimpleNamespace
from typing import Literal, Sequence
tree=ast.parse(Path(sys.argv[1]).read_text())
names={'parse_args','resolve_effective_mode','_parse_bool','_parse_repair_pollutants_arg','_normalise_repair_pollutants','run_integrity_under_global_operation_lock'}
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(functions)==len(names)
scope=dict(globals(),__file__=sys.argv[1],CURRENT_INTEGRITY_HISTORY_VERSION='v3',HISTORY_VERSION_CHOICES=['v3'],DEFAULT_CONCURRENCY=1,
 V2_OBSERVATION_INTEGRITY_POLLUTANTS=['pm25','pm10','no2','o3'],
 ORIGINAL_INTEGRITY_CHANNEL=SimpleNamespace(metadata=None),_repo_root_for_integrity_script=lambda e:Path('/workspace/uk-aq-ops'),
 resolve_history_writer_database_url=lambda e:'synthetic',close_logging_handlers=lambda:None,
 build_integrity_logical_run_context=lambda **k:k,INTEGRITY_LOGICAL_RUN_CONTEXT_ENV='fixture',finish_schema2_diagnostic=lambda *a:None)
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*functions],type_ignores=[])),sys.argv[1],'exec'),scope)
for key in ('GITHUB_ACTIONS','UK_AQ_HISTORY_INTEGRITY_LAUNCHD_JOB_LABEL','UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED'):
 os.environ.pop(key,None)
base=['--env','TEST','--source','sos','--from-day','2026-10-10','--to-day','2026-10-10']
selected=base+['--schema2-read-only-diagnostic','--diagnostic-pollutants','no2']
parsed=scope['parse_args'](selected)
assert scope['resolve_effective_mode'](parsed)=='schema2_diagnostic' and parsed.max_runtime_minutes==5
for extra in (['--run-backfill','--repair-pollutants','no2'],['--dry-run'],['--check-only'],['--profile','daily'],['--env','LIVE'],['--max-runtime-minutes','0'],['--schema2-diagnostic-work-root','/tmp/untrusted']):
 with contextlib.redirect_stderr(io.StringIO()):
  try: scope['parse_args'](selected+extra)
  except SystemExit: pass
  else: raise AssertionError(extra)
os.environ['UK_AQ_HISTORY_INTEGRITY_LAUNCHD_JOB_LABEL']='scheduled'
with contextlib.redirect_stderr(io.StringIO()):
 try: scope['parse_args'](selected)
 except SystemExit: pass
 else: raise AssertionError('scheduled diagnostic admitted')
os.environ.pop('UK_AQ_HISTORY_INTEGRITY_LAUNCHD_JOB_LABEL')
assert scope['resolve_effective_mode'](scope['parse_args'](base))=='check_only'
assert scope['resolve_effective_mode'](scope['parse_args'](base+['--run-backfill','--repair-pollutants','no2']))=='repair_apply'
main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
lines=lambda name:[n.lineno for n in ast.walk(main) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id==name]
assert max(lines('run_integrity_dropbox_currentness_gate')) < lines('run_schema2_diagnostic')[0] < lines('run_preflight_or_die')[0]
with tempfile.TemporaryDirectory() as tmp:
 env={'UK_AQ_HISTORY_INTEGRITY_TMP_DIR':tmp,'UK_AQ_HISTORY_INTEGRITY_REPORT_DIR':tmp}
 paths=[]
 def run(command,**kwargs):
  work=Path(command[-1]); assert command[-2]=='--schema2-diagnostic-work-root' and work.is_dir()
  (work/'synthetic-body').write_text('fixture'); paths.append(work)
  if len(paths)==2: raise RuntimeError('synthetic lifecycle failure')
  return SimpleNamespace(returncode=0)
 scope['subprocess']=SimpleNamespace(run=run)
 scope['run_protected_diagnostic_command']=run
 call=dict(argv=selected,args=parsed,env=env,run_compact='2026-11-05T160000Z',started_at_utc='fixture',log_path='fixture')
 assert scope['run_integrity_under_global_operation_lock'](**call)==0
 try: scope['run_integrity_under_global_operation_lock'](**call)
 except RuntimeError: pass
 else: raise AssertionError('lifecycle failure hidden')
 assert not any(p.exists() for p in paths)
sys.path.insert(0,str(Path(sys.argv[1]).parent))
from integrity.original_operation import OriginalIntegrityChannel
from integrity.schema2_diagnostic import run_protected_diagnostic_command
channel=OriginalIntegrityChannel(None)
try: channel.popen_diagnostic(['node','/workspace/uk-aq-ops/scripts/backup_r2/uk_aq_schema2_read_only_diagnostic.mjs','--write-r2'],repo_root='/workspace/uk-aq-ops',env={})
except RuntimeError: pass
else: raise AssertionError('write route admitted')
with tempfile.TemporaryDirectory() as tmp:
 root=Path(tmp)
 child_code="import signal,sys,time; from pathlib import Path; signal.signal(signal.SIGTERM,lambda *_:(Path(sys.argv[2]).write_text('released'),sys.exit(0))); Path(sys.argv[1]).write_text('ready'); time.sleep(30)"
 outer_code="""
import os,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from integrity.schema2_diagnostic import run_protected_diagnostic_command
with tempfile.TemporaryDirectory(dir=sys.argv[2]) as work:
 Path(sys.argv[2]+'/workspace').write_text(work)
 result=run_protected_diagnostic_command([sys.executable,'-c',sys.argv[3],sys.argv[2]+'/ready',sys.argv[2]+'/released'],cwd=sys.argv[2],env=os.environ)
 assert Path(sys.argv[2]+'/released').exists(), 'scratch must outlive holder cleanup'
sys.exit(result.returncode)
"""
 outer=subprocess.Popen([sys.executable,'-c',outer_code,str(Path(sys.argv[1]).parent),tmp,child_code])
 deadline=time.monotonic()+5
 while not (root/'ready').exists() and time.monotonic()<deadline:
  time.sleep(.01)
 assert (root/'ready').exists()
 outer.send_signal(signal.SIGTERM)
 assert outer.wait(timeout=5)==143
 assert (root/'released').exists()
 assert not Path((root/'workspace').read_text()).exists()
`, source.pathname], { encoding: "utf8", maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("both real APPLY bridges reject preparation and copied inventory before any mutation adapter", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-preparation-reject-"));
  const runStatePath = path.join(dir, "run-state.json");
  try {
    for (const [execution_path, apply] of [
      ["generic_integrity", applyValidatedGenericV3Proposal],
      ["sos_light", applyValidatedSosLightV3Proposal],
    ]) {
      for (const attempt of attempts) {
        fs.writeFileSync(runStatePath, JSON.stringify({ execution_path, ...attempt }));
        const calls = [];
        await assert.rejects(apply({ runStatePath, r2: {},
          env: { UK_AQ_R2_HISTORY_VERSION: "v3", UK_AQ_R2_HISTORY_INDEX_VERSION: "v3" },
          adapters: { putObject: () => calls.push("put"), deleteObjects: () => calls.push("delete") },
        }), /schema2_preparation_not_executable/);
        assert.deepEqual(calls, []);
      }
    }
    assert.doesNotThrow(() => requireNoSchema2PreparationExecution({
      planning: { status: "planned", proposals: [{ key: "ordinaryKey" }] },
      objects: { ordinaryKey: { status: "planned" } },
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real Python scheduling boundaries reject preparation; opaque blocked retention authenticates exact bytes", () => {
  // Extract the actual functions to avoid invoking the operational coordinator.
  const source = new URL("../../uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py", import.meta.url);
  const checked = spawnSync("python3", ["-c", String.raw`
import ast, hashlib, json, re, sys
from pathlib import Path
from typing import Mapping
tree = ast.parse(Path(sys.argv[1]).read_text())
names = {
    "_require_no_schema2_preparation_execution",
    "_authenticate_schema2_preparation_projection",
    "_require_complete_persisted_file_backed_proposal",
    "validate_proposal_run_state_transition",
    "record_integrity_object_operations",
}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(functions) == len(names)
scope = dict(Mapping=Mapping, hashlib=hashlib, json=json, re=re)
module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
exec(compile(ast.fix_missing_locations(module), sys.argv[1], "exec"), scope)
for boundary in ("_require_complete_persisted_file_backed_proposal", "validate_proposal_run_state_transition", "record_integrity_object_operations"):
    for attempt in json.loads(sys.argv[2]):
        try:
            candidate = {"execution_path": "generic_integrity", "objects": {"ordinaryKey": {}}, **attempt}
            if boundary == "record_integrity_object_operations":
                scope[boundary](None, run_id=1, run_state=candidate)
            else:
                scope[boundary](candidate)
        except ValueError as error:
            assert "schema2_preparation_not_executable" in str(error), str(error)
        else:
            raise AssertionError(boundary + " admitted preparation")
state = dict(run_id="run:TEST:preparation", execution_path="generic_integrity")
sidecar = dict(contract_version="uk_aq_integrity_v3_schema2_preparation_v1", state="prepared_only",
    **state, owner="integrity", history_generation="v3", read_only=True,
    repair_apply_eligible=False, publication_eligible=False,
    current_object_authority=None, conditional_publication_authority=None)
body = json.dumps(sidecar, sort_keys=True, separators=(",", ":"))
digest = hashlib.sha256(body.encode()).hexdigest()
sidecar["freeze"] = dict(contract_version="uk_aq_integrity_v3_schema2_preparation_freeze_v1", canonical_json=body, sha256=digest, byte_size=len(body.encode()))
sidecar["fingerprint"] = dict(contract_version="uk_aq_integrity_v3_schema2_preparation_fingerprint_v1", sha256=digest)
authenticate = scope["_authenticate_schema2_preparation_projection"]
assert authenticate(sidecar, run_state=state) == sidecar
scope["_require_no_schema2_preparation_execution"](dict(schema2_preparation=sidecar,
    planning=dict(status="blocked_dependency", proposals=[])), reject_sidecar=False)
for change in (dict(run_id="other-run"), dict(publication_eligible=True), dict(owner="prune")):
    try:
        authenticate(dict(sidecar, **change), run_state=state)
    except ValueError:
        pass
    else:
        raise AssertionError("changed preparation authority was retained")
changed = json.loads(json.dumps(sidecar))
changed["freeze"]["canonical_json"] += " "
try:
    authenticate(changed, run_state=state)
except ValueError:
    pass
else:
    raise AssertionError("changed freeze bytes were retained")
print("Python preparation rejection and opaque retention checks passed")
`, source.pathname, JSON.stringify(attempts)], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /checks passed/);
});
