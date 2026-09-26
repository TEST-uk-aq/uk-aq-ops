import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  materializeSosLightV3ProposalBodies,
  SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
  writeSosLightV3ProposalArtifact,
} from "../lib/sos_light_v3_proposal_transport.mjs";

function proposal(key, body, overrides = {}) {
  return {
    key,
    proposed_body: body,
    bytes: Buffer.byteLength(body),
    new_sha256: sha256Hex(Buffer.from(body)),
    changed: true,
    included_in_write_set: true,
    status: "planned",
    dependencies: [],
    dependency_identities: {},
    ...overrides,
  };
}

function fixture() {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-proposal-transport-"));
  const overlayRoot = path.join(runRoot, "overlay");
  fs.mkdirSync(overlayRoot);
  return {
    runRoot,
    overlayRoot,
    runState: { run_root: runRoot, overlay_root: overlayRoot, objects: {} },
  };
}

test("fixed-v3 proposal transport materialises exact bodies and emits a compact envelope", () => {
  const { runRoot, overlayRoot, runState } = fixture();
  try {
    const key = "history/_index_v3/observations_timeseries/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/manifest.json";
    const largeBody = JSON.stringify({ payload: "x".repeat(1024 * 1024) });
    const skippedKey = "history/_index_v3/unchanged.json";
    const output = {
      ok: true,
      planning: {
        proposals: [
          proposal(key, largeBody),
          proposal(skippedKey, "unchanged", {
            changed: false,
            included_in_write_set: false,
            status: "skipped_unchanged",
          }),
        ],
      },
    };
    const audit = materializeSosLightV3ProposalBodies({ output, overlayRoot, runState });
    const changed = output.planning.proposals[0];
    assert.equal(changed.proposed_body, undefined);
    assert.equal(changed.body, undefined);
    assert.deepEqual(changed.body_ref, {
      contract_version: SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
      source: "planned_overlay",
      relative_path: key,
      sha256: sha256Hex(Buffer.from(largeBody)),
      bytes: Buffer.byteLength(largeBody),
    });
    assert.equal(fs.readFileSync(path.join(overlayRoot, ...key.split("/")), "utf8"), largeBody);
    assert.equal(output.planning.proposals[1].proposed_body, undefined);
    assert.equal(output.planning.proposals[1].body_ref, undefined);
    assert.equal(audit.file_backed_changed_body_count, 1);

    const envelope = writeSosLightV3ProposalArtifact({
      output,
      resultPath: path.join(runRoot, "proposal-results", "proposal.json"),
      runRoot,
    });
    const stdout = JSON.stringify(envelope);
    assert.ok(Buffer.byteLength(stdout) < 4096);
    assert.equal(stdout.includes(largeBody.slice(0, 1000)), false);
    const artifactText = fs.readFileSync(
      path.join(runRoot, envelope.proposal_artifact.relative_path),
      "utf8",
    );
    assert.equal(artifactText.includes(largeBody.slice(0, 1000)), false);
    assert.equal(JSON.parse(artifactText).output.planning.proposals[0].body_ref.sha256,
      changed.new_sha256);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("materialisation reuses an exact staged body and rejects an outside staged path", () => {
  const { runRoot, overlayRoot, runState } = fixture();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-proposal-outside-"));
  try {
    const key = "history/v3/observations/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/manifest.json";
    const body = "already-staged";
    const stagedPath = path.join(overlayRoot, ...key.split("/"));
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.writeFileSync(stagedPath, body);
    const before = fs.statSync(stagedPath).ino;
    runState.objects[key] = {
      local_path: stagedPath,
      sha256: sha256Hex(Buffer.from(body)),
      bytes: Buffer.byteLength(body),
    };
    const output = { ok: true, planning: { proposals: [proposal(key, body)] } };
    materializeSosLightV3ProposalBodies({ output, overlayRoot, runState });
    assert.equal(fs.statSync(stagedPath).ino, before, "exact current-run bytes must not be rewritten");

    const outsidePath = path.join(outsideRoot, "body.json");
    fs.writeFileSync(outsidePath, body);
    const badRunState = {
      ...runState,
      objects: { [key]: { ...runState.objects[key], local_path: outsidePath } },
    };
    assert.throws(
      () => materializeSosLightV3ProposalBodies({
        output: { ok: true, planning: { proposals: [proposal(key, body)] } },
        overlayRoot,
        runState: badRunState,
      }),
      /outside its permitted run-local boundary/,
    );
    assert.throws(
      () => writeSosLightV3ProposalArtifact({
        output,
        resultPath: path.join(outsideRoot, "proposal.json"),
        runRoot,
      }),
      /outside its permitted run-local boundary/,
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});
