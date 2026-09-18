import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFixedV3Proposal,
} from "../uk_aq_plan_sos_light_v3_observation_metadata.mjs";

function proposalWithDependency(dependency) {
  return {
    planning: {
      proposals: [{
        key: "history/_index_v3/observations_timeseries_latest.json",
        dependencies: [dependency],
        dependency_identities: {
          [dependency]: { source: "dropbox", sha256: "a".repeat(64), bytes: 1 },
        },
      }],
    },
  };
}

test("fixed-v3 namespace guard accepts only generation-v3 observation authorities", () => {
  assert.doesNotThrow(() => assertFixedV3Proposal(proposalWithDependency(
    "history/v3/observations/day_utc=2026-06-01/connector_id=1/manifest.json",
  )));
});

test("fixed-v3 namespace guard rejects v2 and unrelated dependency namespaces", () => {
  assert.throws(
    () => assertFixedV3Proposal(proposalWithDependency(
      "history/v2/observations/day_utc=2026-06-01/manifest.json",
    )),
    /outside v3/,
  );
  assert.throws(
    () => assertFixedV3Proposal(proposalWithDependency("history/unrelated/object.json")),
    /outside v3 observation_index/,
  );
});

test("fixed-v3 namespace guard requires an exact dependency identity map", () => {
  const output = proposalWithDependency(
    "history/v3/observations/day_utc=2026-06-01/manifest.json",
  );
  output.planning.proposals[0].dependency_identities = {};
  assert.throws(() => assertFixedV3Proposal(output), /identities are not exact/);
});
