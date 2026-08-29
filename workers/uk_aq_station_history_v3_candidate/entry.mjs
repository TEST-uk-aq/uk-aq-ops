// The code path is the existing station-history contract implementation. This
// separately named deployment is fixed to the v3-only low-level candidate URL
// by its manual deployment workflow; the active station Worker remains intact.
import stationHistoryWorker from "../uk_aq_station_history/src/index.mjs";

export function assertV3Candidate(env) {
  if (String(env.UK_AQ_R2_HISTORY_INDEX_VERSION || "") !== "v3") {
    throw new Error("Station-history v3 candidate requires index generation v3");
  }
  const activeObservationsWorkerName = String(
    env.UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME || "",
  ).trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(activeObservationsWorkerName)) {
    throw new Error("Station-history v3 candidate requires the active observations Worker name");
  }
  const expectedCandidateWorkerName = `${activeObservationsWorkerName}-v3-candidate`;
  let url;
  try {
    url = new URL(String(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL || ""));
  } catch {
    throw new Error("Station-history v3 candidate requires a valid observations candidate URL");
  }
  const expectedHostname = new RegExp(
    `^${expectedCandidateWorkerName}\\.[a-z0-9-]+\\.workers\\.dev$`,
    "i",
  );
  if (
    url.protocol !== "https:"
    || !expectedHostname.test(url.hostname)
  ) {
    throw new Error(
      `Station-history v3 candidate requires the ${expectedCandidateWorkerName} observations URL`,
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    assertV3Candidate(env);
    return stationHistoryWorker.fetch(request, env, ctx);
  },
};
