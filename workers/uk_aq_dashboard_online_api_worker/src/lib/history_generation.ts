import type { WorkerEnv } from "./upstream";

export type HistoryResolution = {
  version: "v2" | "v3";
  label: string;
  source: "stable_observations_history_service";
  valid: true;
  warning: null;
  raw: string;
  resolved_at: string;
  generation: Record<string, string>;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history descriptor object");
  return value as Record<string, unknown>;
}

async function readDescriptor(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Missing history descriptor body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error("History descriptor exceeds 16 KiB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return object(JSON.parse(new TextDecoder().decode(bytes)));
}

// The authenticated stable service chooses the version. These assertions only
// validate its wire contract; they are not an independent selection mechanism.
export async function resolveHistoryEnvironment(env: WorkerEnv): Promise<WorkerEnv> {
  const base = String(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL || "").trim();
  const token = String(env.UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN || "").trim();
  if (!base || !token) throw new Error("Stable observations-history URL/token is required");
  const url = new URL("/v1/history-generation", base);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid stable history URL");
  const response = await fetch(url, {
    headers: { "x-uk-aq-upstream-auth": token, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(10000), cache: "no-store",
  });
  if (!response.ok) throw new Error(`History generation authority HTTP ${response.status}`);
  const p = await readDescriptor(response);
  const version = p.read_version;
  if (p.ok !== true || p.kind !== "uk_aq_observation_history_generation" || p.schema_version !== 1 ||
      p.source !== "stable_observations_history_service" || p.selector !== "UK_AQ_R2_HISTORY_VERSION" ||
      (version !== "v2" && version !== "v3") || typeof p.resolved_at !== "string" ||
      !Number.isFinite(Date.parse(p.resolved_at))) throw new Error("Invalid history generation descriptor");
  const g = object(p.generation);
  const expected: Record<string, string> = {
    version, observations_prefix: `history/${version}/observations`,
    observations_root_key: `history/${version}/observations/_manifests/manifest.json`,
    observations_runs_prefix: `history/${version}/_ops/observations/runs`,
    index_root_prefix: `history/_index_${version}`,
    observations_timeseries_index_prefix: `history/_index_${version}/observations_timeseries`,
    observations_timeseries_latest_key: `history/_index_${version}/observations_timeseries_latest.json`,
    timeseries_binding_index_prefix: `history/_index_${version}/timeseries_binding`,
    core_prefix: `history/${version}/core`,
    backup_state_prefix: `_ops/checkpoints/r2_history_backup_state_v2${version === "v3" ? "/generation=v3" : ""}`,
    backup_inventory_prefix: `history/_index_${version}/backup_inventory_v2`,
    timeseries_binding_pack_prefix: `history/_backup_packs_v1/timeseries_binding${version === "v3" ? "/generation=v3" : ""}`,
  };
  if (Object.entries(expected).some(([key, value]) => g[key] !== value)) throw new Error("Inconsistent history descriptor paths");
  return { ...env, historyResolution: {
    version, label: `R2_${version}`, source: p.source, valid: true, warning: null,
    raw: version, resolved_at: p.resolved_at,
    generation: Object.fromEntries(Object.keys(expected).map(key => [key, String(g[key])])),
  } };
}

export function historyResolution(env: WorkerEnv): HistoryResolution {
  if (!env.historyResolution) throw new Error("History generation authority was not resolved");
  return env.historyResolution;
}

export function assertHistoryPayload(payload: Record<string, unknown>, env: WorkerEnv): void {
  if (payload.read_version !== historyResolution(env).version || payload.error || payload.ok === false) {
    throw new Error("History payload does not match serving generation or reports failure");
  }
}
