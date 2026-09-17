#!/usr/bin/env node
// Proposal-only fixed-v3 observation metadata planner.
import { pathToFileURL } from "node:url";
import {
  runV2ObservationsRepair,
} from "./uk_aq_execute_v2_observations_repair_impl.mjs";

const V3_OBJECT_PREFIXES = ["history/v3/observations/", "history/_index_v3/"];
const V2_OBJECT_PREFIXES = ["history/v2/", "history/_index_v2/"];

function assertFixedV3Proposal(output) {
  for (const proposal of output?.planning?.proposals || []) {
    const key = String(proposal?.key || "");
    if (V2_OBJECT_PREFIXES.some((prefix) => key.startsWith(prefix))
      || !V3_OBJECT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`Fixed-v3 metadata planner produced a non-v3 object: ${key}`);
    }
    for (const dependency of proposal?.dependencies || []) {
      const dependencyKey = String(dependency || "");
      if (V2_OBJECT_PREFIXES.some((prefix) => dependencyKey.startsWith(prefix))) {
        throw new Error(
          `Fixed-v3 metadata planner retained a v2 dependency: ${key} -> ${dependencyKey}`,
        );
      }
    }
  }
  return output;
}

export async function planSosLightV3ObservationMetadata(options = {}) {
  const output = await runV2ObservationsRepair({
    ...options,
    storageGeneration: "v3",
  });
  return assertFixedV3Proposal(output);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  planSosLightV3ObservationMetadata().then((output) => {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
