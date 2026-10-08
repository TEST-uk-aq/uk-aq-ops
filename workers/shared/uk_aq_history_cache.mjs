import contract from "../../config/uk_aq_history_cache.json" with { type: "json" };
import { resolveObservationHistoryGeneration } from "./uk_aq_observation_history_generation.mjs";

export const HISTORY_CACHE_CONTRACT = Object.freeze(contract);
export const HISTORY_DEPENDENCIES_HEADER = "X-UK-AQ-History-Cache-Tags";
export function historyCacheEnabled(env) {
  return String(env.UK_AQ_ENV_NAME ?? "").trim() === contract.environment;
}
export function historyCacheTag(generation, timeseriesId) {
  if (!["v2", "v3"].includes(generation) || !Number.isSafeInteger(Number(timeseriesId)) || Number(timeseriesId) <= 0) {
    throw new Error("Invalid physical history cache identity");
  }
  return contract.tag_template.replace("{generation}", generation).replace("{timeseries_id}", String(Number(timeseriesId)));
}
export function historyCacheKeyUrl(value, env) {
  const url = new URL(value);
  if (historyCacheEnabled(env)) url.searchParams.set("__uk_aq_history_tags", contract.cutover_marker);
  return url;
}
// Called only with authenticated reader/binding identities, never public query IDs.
export function applyHistoryDependencyHeaders(headers, env, timeseriesIds) {
  if (!historyCacheEnabled(env)) return headers;
  try {
    const generation = resolveObservationHistoryGeneration(env).version;
    const tags = [...new Set(timeseriesIds.map((id) => historyCacheTag(generation, id)))].sort();
    if (!tags.length || tags.length > contract.max_response_tags) throw new Error("Unbounded or missing history dependencies");
    headers.set(HISTORY_DEPENDENCIES_HEADER, tags.join(","));
    headers.set("Cache-Tag", tags.join(","));
  } catch {
    headers.delete(HISTORY_DEPENDENCIES_HEADER);
    headers.delete("Cache-Tag");
    headers.set("Cache-Control", "no-store");
  }
  return headers;
}
// The caller must obtain headers from its private Service Binding/upstream.
export function authenticatedHistoryTags(headers, env) {
  if (!historyCacheEnabled(env)) return null;
  const generation = resolveObservationHistoryGeneration(env).version;
  const tags = String(headers.get(HISTORY_DEPENDENCIES_HEADER) ?? "").split(",").filter(Boolean);
  if (!tags.length || tags.length > contract.max_response_tags) return null;
  const [prefix, suffix] = contract.tag_template.replace("{generation}", generation).split("{timeseries_id}");
  if (tags.some((tag) => {
    if (!tag.startsWith(prefix) || !tag.endsWith(suffix)) return true;
    const id = tag.slice(prefix.length, suffix ? -suffix.length : undefined);
    return !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || historyCacheTag(generation, Number(id)) !== tag;
  })) return null;
  return [...new Set(tags)].sort();
}
