import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { requireNoSchema2PreparationExecution } from "../lib/schema2_preparation_execution_guard.mjs";
import { applyValidatedGenericV3Proposal } from "../uk_aq_apply_generic_v3_proposal.mjs";
import { applyValidatedSosLightV3Proposal } from "../uk_aq_apply_sos_light_v3_proposal.mjs";

const contract = "uk_aq_integrity_v3_schema2_preparation_v1";
const attempts = [
  { schema2_preparation: null },
  { schema2_preparation: { contract_version: contract, state: "prepared_only" } },
  { objects: { ordinaryKey: { preparation_contract_version: contract } } },
  { planning: { status: "planned", proposals: [{ contract_version: contract, state: "prepared_only" }] } },
];

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
