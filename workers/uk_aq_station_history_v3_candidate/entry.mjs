// The code path is the existing station-history contract implementation. This
// separately named deployment is fixed to the v3-only low-level candidate URL
// by its manual deployment workflow; the active station Worker remains intact.
import stationHistoryWorker from "../uk_aq_station_history/src/index.mjs";

function assertV3Candidate(env) {
  if (String(env.UK_AQ_R2_HISTORY_INDEX_VERSION || "").trim().toLowerCase() !== "v3") {
    throw new Error("Station-history v3 candidate requires index generation v3");
  }
  const url = new URL(String(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL || ""));
  if (
    url.protocol !== "https:"
    || !/^uk-aq-observs-history-r2-api-v3-candidate\.[a-z0-9-]+\.workers\.dev$/i.test(url.hostname)
  ) {
    throw new Error("Station-history v3 candidate requires the fixed v3 observations candidate URL");
  }
}

export default {
  async fetch(request, env, ctx) {
    assertV3Candidate(env);
    return stationHistoryWorker.fetch(request, env, ctx);
  },
};
