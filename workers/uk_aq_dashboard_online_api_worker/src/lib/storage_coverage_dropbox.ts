import type { WorkerEnv } from "./upstream";
import { CoverageRequestBudget } from "./coverage_request_budget";
import { coverageDay, coverageFailureReason } from "./storage_day_presence";
import { DROPBOX_DOWNLOAD_URL, fetchDropboxAccessToken, joinDropboxStatePath, resolveDropboxStatePath } from "./direct";
import { historyResolution, resolveHistoryEnvironment } from "./history_generation";
import { buildJsonResponse } from "./http";

type ObjectValue = Record<string, unknown>;
type Month = { year: string; month: string; key: string; hash: string; processed: string | null };
type Collection = {
  id: string; expires: number; checkpoint: string; refs: Month[];
  cursor: number; days: string[]; checkpointComplete: boolean;
};
type Snapshot = { checkpoint: string; total: number; days: string[]; verifiedAt: string; checkpointComplete: boolean };
const BATCH_SIZE = 8;
const COLLECTION_SECONDS = 600;
const SNAPSHOT_SECONDS = 300;
const SHARD_SECONDS = 86400;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROTOCOL = "checkpoint_batches_v1";

class CheckpointError extends Error {
  constructor(message: string, readonly restart = false) { super(message); }
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CheckpointError("malformed checkpoint");
  return value as ObjectValue;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

// Read/hash the original UTF-8 bytes: producer state_shard_hash authenticates
// stableJson(payload), including formatting and trailing newline, not parsed JSON.
async function download(env: WorkerEnv, token: string, path: string, maxBytes: number) {
  const response = await env.coverageRequestBudget!.fetch(DROPBOX_DOWNLOAD_URL, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CheckpointError([401, 403].includes(response.status)
      ? `checkpoint authentication failed (HTTP ${response.status})` : `checkpoint HTTP ${response.status}`);
  }
  if (!response.body) throw new CheckpointError("missing checkpoint body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new CheckpointError("checkpoint exceeds size bound");
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let payload: ObjectValue;
  try { payload = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new CheckpointError("malformed checkpoint JSON"); }
  return { payload, hash: await sha256(bytes) };
}

function months(root: ObjectValue, env: WorkerEnv): Month[] {
  const generation = historyResolution(env);
  if (root.schema_version !== 1 || root.kind !== "uk_aq_r2_history_backup_state_v2_root"
    || root.backup_version !== "v2" || root.observation_generation !== generation.version) {
    throw new CheckpointError("checkpoint generation or schema mismatch");
  }
  const observations = object(root.observations);
  if (observations.processed_source_root_hash != null && (typeof observations.processed_source_root_hash !== "string"
    || !SHA.test(observations.processed_source_root_hash))) throw new CheckpointError("invalid processed checkpoint root hash");
  if (!Array.isArray(observations.years)) throw new CheckpointError("malformed checkpoint month references");
  const refs: Month[] = [];
  const seenYears = new Set<string>(), seenMonths = new Set<string>();
  for (const rawYear of observations.years) {
    const yearEntry = object(rawYear), year = String(yearEntry.year || "");
    if (!/^[0-9]{4}$/.test(year) || year === "0000" || seenYears.has(year) || !Array.isArray(yearEntry.months)) {
      throw new CheckpointError("invalid or duplicate checkpoint year");
    }
    seenYears.add(year);
    if (yearEntry.processed_source_year_hash != null && (typeof yearEntry.processed_source_year_hash !== "string"
      || !SHA.test(yearEntry.processed_source_year_hash))) throw new CheckpointError("invalid processed checkpoint year hash");
    if (observations.processed_source_root_hash && !yearEntry.processed_source_year_hash) {
      throw new CheckpointError("checkpoint parent claims completion before its years");
    }
    for (const rawMonth of yearEntry.months) {
      const entry = object(rawMonth), month = String(entry.month || "").padStart(2, "0");
      const key = `${generation.generation.backup_state_prefix}/observations/year=${year}/month=${month}.json`;
      if (!/^(0[1-9]|1[0-2])$/.test(month) || seenMonths.has(`${year}-${month}`)
        || entry.state_shard_key !== key || typeof entry.state_shard_hash !== "string" || !SHA.test(entry.state_shard_hash)
        || entry.processed_source_month_hash != null && (typeof entry.processed_source_month_hash !== "string" || !SHA.test(entry.processed_source_month_hash))) {
        throw new CheckpointError("invalid checkpoint month identity or hash");
      }
      seenMonths.add(`${year}-${month}`);
      refs.push({ year, month, key, hash: entry.state_shard_hash, processed: entry.processed_source_month_hash as string | null ?? null });
    }
  }
  if (refs.length > 12000) throw new CheckpointError("checkpoint reference count exceeds size bound");
  if (observations.processed_source_root_hash && refs.some(ref => !ref.processed)) {
    throw new CheckpointError("checkpoint parent claims completion before its months");
  }
  return refs.sort((a, b) => a.key.localeCompare(b.key));
}

async function observationCheckpoint(root: ObjectValue, refs: Month[], env: WorkerEnv): Promise<string> {
  const observations = object(root.observations);
  // Binding/Core progress can rewrite the shared root without changing any
  // observation evidence. Identity covers the complete selected observation
  // subtree; unrelated domains cannot invalidate its content-addressed receipts.
  const years = (observations.years as ObjectValue[]).map(year => [String(year.year), year.processed_source_year_hash ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return sha256(new TextEncoder().encode(JSON.stringify([
    historyResolution(env).generation, observations.processed_source_root_hash ?? null, years, refs,
  ])));
}

function monthDays(shard: ObjectValue, ref: Month): string[] {
  if (shard.schema_version !== 1 || shard.kind !== "uk_aq_r2_history_backup_state_observations_month"
    || shard.backup_version !== "v2" || shard.domain !== "observations"
    || String(shard.year) !== ref.year || String(shard.month).padStart(2, "0") !== ref.month
    || (shard.processed_source_month_hash ?? null) !== ref.processed
    || !Array.isArray(shard.days) || shard.days.length > 31) {
    throw new CheckpointError("malformed checkpoint shard identity or completeness");
  }
  const days = new Set<string>();
  for (const value of shard.days) {
    const row = object(value), day = coverageDay(row.day_utc);
    const copied = typeof row.copied_at === "string" ? Date.parse(row.copied_at) : NaN;
    if (!day || !day.startsWith(`${ref.year}-${ref.month}-`) || days.has(day)
      || day > new Date().toISOString().slice(0, 10) || typeof row.manifest_hash !== "string" || !SHA.test(row.manifest_hash)
      || !Number.isFinite(copied) || copied > Date.now() + 60000) {
      throw new CheckpointError("malformed checkpoint shard day or copy evidence");
    }
    days.add(day);
  }
  return [...days].sort();
}

// No in-memory continuation or provider I/O promise survives this invocation.
// Immutable step keys make retries/concurrent continuations idempotent: an older
// completion cannot overwrite a later step. Cache loss requires a fresh start.
export async function handleDropboxCoverage(request: Request, originalEnv: WorkerEnv): Promise<Response> {
  const budget = originalEnv.coverageRequestBudget || new CoverageRequestBudget();
  const env = { ...originalEnv, coverageRequestBudget: budget };
  const version = historyResolution(env).version;
  const descriptor = JSON.stringify(historyResolution(env).generation);
  let state: Collection | null = null;
  const reply = (status: "pending" | "ok" | "partial" | "unavailable", extra: ObjectValue = {}) => buildJsonResponse({
    r2_history_read_version: historyResolution(env),
    dropbox_coverage: {
      protocol: PROTOCOL, status, complete: status === "ok" || status === "partial", generation: version,
      checked_shards: state?.cursor ?? 0, total_shards: state?.refs.length ?? null,
      remaining_shards: state ? state.refs.length - state.cursor : null,
      checkpoint_id: state?.checkpoint ?? null, checked_at_utc: new Date().toISOString(),
      checkpoint_complete: state?.checkpointComplete ?? false,
      request_budget_used: budget.used, request_budget_limit: budget.limit,
      ...extra,
    },
  });
  try {
    const target = resolveDropboxStatePath(env);
    if (!target.path) throw new CheckpointError("checkpoint source is unavailable");
    const context = await sha256(new TextEncoder().encode(JSON.stringify([
      descriptor, target.path, env.DROPBOX_APP_KEY || "", env.DROPBOX_REFRESH_TOKEN || "",
    ])));
    const cache = (caches as CacheStorage & { default: Cache }).default;
    const key = (suffix: string) => new Request(new URL(`/__uk_aq_calendar_cache/v1/${context}/${suffix}`, request.url));
    const read = async <T>(suffix: string): Promise<T | null> => {
      const response = await budget.match(cache, key(suffix));
      return response ? await response.json() as T : null;
    };
    const write = (suffix: string, value: unknown, seconds: number) => budget.put(cache, key(suffix),
      buildJsonResponse(value, 200, `public, max-age=${seconds}`));
    const search = new URL(request.url).searchParams;
    const id = search.get("collection_id"), cursor = search.get("cursor");
    if (id || cursor) {
      if (!id || !UUID.test(id) || !cursor || !/^[0-9]{1,5}$/.test(cursor)) throw new CheckpointError("invalid checkpoint continuation");
      state = await read<Collection>(`collection/${id}/${cursor}`);
      if (!state || state.id !== id || state.cursor !== Number(cursor) || state.expires <= Date.now()) {
        throw new CheckpointError("checkpoint collection expired or cache entry unavailable", true);
      }
    }
    const tokenResult = await fetchDropboxAccessToken(env);
    if (!tokenResult.token) {
      if (/subrequest.*(?:limit|budget)|too many (?:subrequests|api requests)/i.test(tokenResult.error || "")) {
        throw new CheckpointError("subrequest budget exhausted");
      }
      if (/timed? ?out|timeout|aborted/i.test(tokenResult.error || "")) throw new CheckpointError("checkpoint token request timed out");
      const status = /\(([1-5][0-9]{2})\)/.exec(tokenResult.error || "")?.[1];
      throw new CheckpointError(status ? `checkpoint token HTTP ${status}` : "checkpoint authentication unavailable");
    }
    const token = tokenResult.token;
    const root = await download(env, token, target.path, 2 * 1024 * 1024);
    const refs = months(root.payload, env);
    const checkpoint = await observationCheckpoint(root.payload, refs, env);
    if (state && state.checkpoint !== checkpoint) throw new CheckpointError("checkpoint changed during collection", true);
    const assertCurrentGeneration = async () => {
      const current = await resolveHistoryEnvironment(env);
      if (JSON.stringify(historyResolution(current).generation) !== descriptor) throw new CheckpointError("serving generation changed during collection", true);
    };
    if (!state) {
      const complete = await read<Snapshot>(`complete/${checkpoint}`);
      if (complete && complete.checkpoint === checkpoint && complete.total === refs.length) {
        await assertCurrentGeneration();
        return reply(complete.checkpointComplete ? "ok" : "partial", {
          checkpoint_id: checkpoint, total_shards: refs.length, checked_shards: refs.length,
          checkpoint_complete: complete.checkpointComplete,
          remaining_shards: 0, days: complete.days, verified_at_utc: complete.verifiedAt });
      }
      state = { id: crypto.randomUUID(), expires: Date.now() + COLLECTION_SECONDS * 1000,
        checkpoint, refs, cursor: 0, days: [],
        checkpointComplete: Boolean(object(root.payload.observations).processed_source_root_hash) };
    }
    const days = new Set(state.days), end = Math.min(state.cursor + BATCH_SIZE, state.refs.length);
    // Eight shards at most. Cold-cache case spends three operations per shard:
    // match + download + put. No database or unrelated metrics work occurs here.
    for (let index = state.cursor; index < end; index++) {
      const ref = state.refs[index];
      const cached = await read<{ hash: string; processed: string | null; days: string[] }>(`month/${ref.year}-${ref.month}`);
      let checkedDays: string[];
      if (cached?.hash === ref.hash && cached.processed === ref.processed) {
        checkedDays = cached.days;
      } else {
        const shard = await download(env, token, joinDropboxStatePath(env, ref.key), 65536);
        if (shard.hash !== ref.hash) throw new CheckpointError("checkpoint shard hash mismatch; collection incomplete", true);
        checkedDays = monthDays(shard.payload, ref);
        await write(`month/${ref.year}-${ref.month}`, { hash: ref.hash, processed: ref.processed, days: checkedDays }, SHARD_SECONDS);
      }
      for (const day of checkedDays) days.add(day);
    }
    state = { ...state, cursor: end, days: [...days].sort() };
    if (end < state.refs.length) {
      await write(`collection/${state.id}/${end}`, state, Math.max(1, Math.floor((state.expires - Date.now()) / 1000)));
      return reply("pending", { collection_id: state.id, cursor: end });
    }
    // Root is published last by the producer. Re-read it before committing a
    // complete snapshot so changed/mixed children can never become success.
    const finalRoot = await download(env, token, target.path, 2 * 1024 * 1024);
    const finalCheckpoint = await observationCheckpoint(finalRoot.payload, months(finalRoot.payload, env), env);
    if (finalCheckpoint !== state.checkpoint) throw new CheckpointError("checkpoint changed before snapshot completion", true);
    await assertCurrentGeneration();
    const snapshot: Snapshot = { checkpoint: state.checkpoint, total: state.refs.length,
      days: state.days, verifiedAt: new Date().toISOString(), checkpointComplete: state.checkpointComplete };
    // Fully read partial producer state may expose confirmed day successes, but
    // must never be published into the verified-complete snapshot cache.
    if (state.checkpointComplete) await write(`complete/${state.checkpoint}`, snapshot, SNAPSHOT_SECONDS);
    return reply(state.checkpointComplete ? "ok" : "partial", { days: snapshot.days, verified_at_utc: snapshot.verifiedAt });
  } catch (err) {
    const error = err instanceof CheckpointError ? err.message : coverageFailureReason(err);
    return reply("unavailable", { error: `Dropbox backup unavailable: ${error}`,
      restart_required: err instanceof CheckpointError && err.restart });
  }
}
