type JsonObject = Record<string, unknown>;
export type PresenceConnection = {
  // Source URL and schema only; never credentials or browser-provided identity.
  key: string;
  fetchChunk(from: string, toExclusive: string): Promise<unknown>;
};
export type IngestCoverageMetadata = {
  source: string;
  status: "ok" | "unavailable";
  checked_at_utc: string | null;
  checked_through_utc: string | null;
  expires_at_utc: string;
  from_day_utc: string;
  to_day_utc_exclusive: string;
  stale: false;
};
type Evidence = {
  days: Map<string, boolean> | null;
  metadata: IngestCoverageMetadata;
  error: string | null;
};
type SourceCache = {
  revision: number;
  entries: Map<string, { expires: number; evidence: Evidence }>;
  pending: Map<string, Promise<Evidence>>;
};
const sources = new Map<string, SourceCache>();
const DAY_MS = 86400000;
const TTL_MS = 300000;
const RPC = "uk_aq_rpc_observation_day_presence_v1";

export function coverageDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value < "0001-01-01") return null;
  const ms = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}
function addDays(day: string, count: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + count * DAY_MS).toISOString().slice(0, 10);
}
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/.test(value)
    && coverageDay(value.slice(0, 10)) !== null && Number.isFinite(Date.parse(value));
}

// Strict complete-response validation: never turn missing/invalid evidence into false.
function validateChunk(value: unknown, from: string, to: string): { days: Map<string, boolean>; checked: string } {
  const payload = object(value);
  const count = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (!payload || payload.schema_version !== 1 || payload.complete !== true
    || payload.from_day_utc !== from || payload.to_day_utc_exclusive !== to
    || payload.checked_day_count !== count || !Array.isArray(payload.days) || payload.days.length !== count
    || !timestamp(payload.checked_at_utc)
    || payload.current_day_utc !== payload.checked_at_utc.slice(0, 10)
    || to > addDays(String(payload.current_day_utc), 1)) {
    throw new Error("IngestDB daily presence response failed validation");
  }
  const days = new Map<string, boolean>();
  for (let i = 0; i < count; i++) {
    const row = object(payload.days[i]);
    const expected = addDays(from, i);
    if (!row || row.day_utc !== expected || typeof row.present !== "boolean" || days.has(expected)) {
      throw new Error("IngestDB daily presence dates are incomplete or invalid");
    }
    days.set(expected, row.present);
  }
  return { days, checked: payload.checked_at_utc };
}

async function load(connection: PresenceConnection, from: string, to: string, force: boolean): Promise<Evidence> {
  let source = sources.get(connection.key);
  if (!source) {
    source = { revision: 0, entries: new Map(), pending: new Map() };
    // Environment-bound cache identities; bounded process memory, no persisted authority.
    if (sources.size >= 8) sources.delete(sources.keys().next().value!);
    sources.set(connection.key, source);
  }
  if (force) {
    source.revision++;
    source.entries.clear();
    source.pending.clear();
  }
  const range = from + ":" + to;
  const cached = source.entries.get(range);
  if (cached && Date.now() < cached.expires) return cached.evidence;
  const pending = source.pending.get(range);
  if (pending) return pending;
  const revision = source.revision;
  const currentSource = source;
  const task = (async (): Promise<Evidence> => {
    const checked: string[] = [];
    const days = new Map<string, boolean>();
    let error: string | null = null;
    try {
      for (let cursor = from; cursor < to;) {
        const end = addDays(cursor, Math.min(366, (Date.parse(to) - Date.parse(cursor)) / DAY_MS));
        const chunk = validateChunk(await connection.fetchChunk(cursor, end), cursor, end);
        for (const [day, present] of chunk.days) days.set(day, present);
        checked.push(chunk.checked);
        cursor = end;
      }
    } catch {
      // Bounded diagnostic; no provider body, URL or credentials in public errors.
      error = "Authoritative IngestDB daily presence is unavailable or invalid";
    }
    if (revision !== currentSource.revision) return load(connection, from, to, false);
    checked.sort((a, b) => Date.parse(a) - Date.parse(b));
    const expires = error ? Date.now() + 30000 : Math.min(Date.now() + TTL_MS, Date.parse(checked[0]) + TTL_MS);
    const evidence: Evidence = {
      days: error ? null : days,
      error,
      metadata: {
        source: RPC, status: error ? "unavailable" : "ok",
        checked_at_utc: error ? null : checked[0],
        checked_through_utc: error ? null : checked[checked.length - 1],
        expires_at_utc: new Date(expires).toISOString(),
        from_day_utc: from, to_day_utc_exclusive: to, stale: false,
      },
    };
    if (currentSource.entries.size >= 8) currentSource.entries.delete(currentSource.entries.keys().next().value!);
    currentSource.entries.set(range, { expires, evidence });
    return evidence;
  })();
  source.pending.set(range, task);
  try { return await task; }
  finally { if (source.pending.get(range) === task) source.pending.delete(range); }
}

export function stripRetiredCalendarCoverage<T extends { storage_coverage_days: unknown[] }>(payload: T): T {
  const clean = { ...payload } as T & JsonObject;
  for (const key of ["dropbox_backup_aqilevels_earliest_day", "dropbox_backup_aqilevels_latest_day"]) delete clean[key];
  clean.storage_coverage_days = payload.storage_coverage_days.map(value => {
    const row = object(value);
    if (!row) return value;
    const result = { ...row };
    for (const key of ["obs_aqi_aqilevels", "r2_aqilevels", "dropbox_aqilevels", "aqilevels"]) delete result[key];
    return result;
  });
  return clean;
}

export async function applyIngestDayPresence<T extends { storage_coverage_days: unknown[] }>(
  payload: T, connection: () => PresenceConnection, force = false,
): Promise<T & { ingest_coverage?: IngestCoverageMetadata; ingest_coverage_error?: string | null }> {
  const clean = stripRetiredCalendarCoverage(payload);
  const dates = clean.storage_coverage_days.flatMap(row => {
    const day = coverageDay(object(row)?.date);
    return day ? [day] : [];
  }).sort();
  if (!dates.length) return clean;
  const from = dates[0], to = addDays(dates[dates.length - 1], 1);
  let evidence: Evidence;
  try { evidence = await load(connection(), from, to, force); }
  catch {
    evidence = { days: null, error: "IngestDB daily presence connection is not configured",
      metadata: { source: RPC, status: "unavailable", checked_at_utc: null, checked_through_utc: null,
        expires_at_utc: new Date().toISOString(), from_day_utc: from, to_day_utc_exclusive: to, stale: false } };
  }
  return {
    ...clean,
    storage_coverage_days: clean.storage_coverage_days.map(value => {
      const row = object(value);
      if (!row) return value;
      const day = coverageDay(row.date);
      return { ...row, ingest: day ? evidence.days?.get(day) ?? null : null };
    }),
    ingest_coverage: evidence.metadata,
    ingest_coverage_error: evidence.error,
  };
}
