// The code path is the existing station-history contract implementation. This
// separately named deployment is fixed to the v3-only low-level candidate URL
// by its manual deployment workflow; the active station Worker remains intact.
import stationHistoryWorker from "../uk_aq_station_history/src/index.mjs";
import {
  buildV3ContinuationPage,
  StationHistoryContinuationError,
} from "../uk_aq_station_history/src/v3_continuation.mjs";

const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";

function required(value) { return String(value ?? "").trim(); }

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function authorize(request, env) {
  const expected = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  const supplied = required(request.headers.get(UPSTREAM_AUTH_HEADER));
  if (!expected) return { ok: false, status: 500, code: "station_history_candidate_auth_config_missing" };
  return supplied && timingSafeEqual(supplied, expected)
    ? { ok: true }
    : { ok: false, status: 401, code: "station_history_candidate_unauthorized" };
}

function jsonError(status, code, route) {
  return new Response(JSON.stringify({ ok: false, error: { code, route } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-UK-AQ-Station-History-Contract": "v2",
    },
  });
}

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
  const expectedCandidateWorkerName = `${activeObservationsWorkerName}-v3-leaf-candidate`;
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
    const url = new URL(request.url);
    try {
      assertV3Candidate(env);
    } catch (error) {
      return jsonError(500, error instanceof Error ? error.message : "station_history_candidate_config_invalid", url.pathname);
    }
    const auth = authorize(request, env);
    if (!auth.ok) return jsonError(auth.status, auth.code, url.pathname);
    if (
      request.method === "GET"
      && url.pathname === "/v1/observations-history"
    ) {
      try {
        const built = await buildV3ContinuationPage({ request, env });
        return new Response(JSON.stringify(built.body), { status: 200, headers: built.headers });
      } catch (error) {
        if (error instanceof StationHistoryContinuationError) {
          return jsonError(error.status, error.code, url.pathname);
        }
        return jsonError(502, error instanceof Error ? error.message : "station_history_v3_continuation_failed", url.pathname);
      }
    }
    return stationHistoryWorker.fetch(request, env, ctx);
  },
};
