import assert from "node:assert/strict";

const CACHE_BUSTER_KEYS = new Set(["_t", "timestamp", "cache_bust", "random"]);
const ALLOWED_WINDOWS = new Set(["12h", "24h", "7d", "31d", "90d"]);

function parseBooleanFlag(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveFlags({ enabled, proxyFirst, r2First, allowIngestOverwrite }) {
  return {
    enabled: parseBooleanFlag(enabled),
    proxyFirst: parseBooleanFlag(proxyFirst),
    r2First: parseBooleanFlag(r2First),
    allowIngestOverwrite: parseBooleanFlag(allowIngestOverwrite),
  };
}

function isTimeseriesV2Request(url, upstreamFunction, flags) {
  return upstreamFunction === "uk_aq_timeseries"
    && flags.enabled
    && flags.proxyFirst
    && String(url.searchParams.get("v") ?? "").trim() === "2";
}

function normalizeIsoOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parsePositiveIntegerStringOrNull(value, min = 1, max = 2_147_483_647) {
  const text = String(value ?? "").trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) return null;
  return String(Math.floor(numeric));
}

function canonicalizeTimeseriesV2RequestUrl(url, allowCacheBypassParams) {
  const original = new URL(url.toString());
  if (!allowCacheBypassParams) {
    for (const key of CACHE_BUSTER_KEYS) {
      original.searchParams.delete(key);
    }
  }

  const normalized = new URL(original.origin + original.pathname);
  const timeseriesId = parsePositiveIntegerStringOrNull(original.searchParams.get("timeseries_id"));
  const startUtc = normalizeIsoOrNull(original.searchParams.get("start_utc") || original.searchParams.get("start"));
  const endUtc = normalizeIsoOrNull(original.searchParams.get("end_utc") || original.searchParams.get("end"));
  const since = normalizeIsoOrNull(original.searchParams.get("since"));
  const windowValue = String(original.searchParams.get("window") ?? "").trim().toLowerCase();
  const hasValidRange = Boolean(startUtc && endUtc && Date.parse(endUtc) > Date.parse(startUtc));

  if (timeseriesId) normalized.searchParams.set("timeseries_id", timeseriesId);
  if (windowValue && ALLOWED_WINDOWS.has(windowValue) && !hasValidRange) {
    normalized.searchParams.set("window", windowValue);
  }
  if (since) normalized.searchParams.set("since", since);
  if (hasValidRange) {
    normalized.searchParams.set("start_utc", startUtc);
    normalized.searchParams.set("end_utc", endUtc);
  }
  normalized.searchParams.set("format", "json");
  normalized.searchParams.set("v", "2");
  if (allowCacheBypassParams) {
    for (const [key, value] of original.searchParams.entries()) {
      if (["timeseries_id", "window", "since", "start_utc", "end_utc", "format", "v"].includes(key)) {
        continue;
      }
      normalized.searchParams.append(key, value);
    }
  }
  return normalized;
}

function runChecks() {
  const flagsOn = resolveFlags({
    enabled: "true",
    proxyFirst: "1",
    r2First: "true",
    allowIngestOverwrite: "false",
  });
  const flagsOff = resolveFlags({
    enabled: "false",
    proxyFirst: "true",
    r2First: "false",
    allowIngestOverwrite: "false",
  });

  const v2Url = new URL(
    "https://example.test/api/aq/timeseries"
    + "?timeseries_id=3742"
    + "&window=24H"
    + "&start=2026-05-14T10:00:00Z"
    + "&end=2026-05-14T16:00:00Z"
    + "&since=2026-05-14T11:11:11Z"
    + "&cache_bust=123"
    + "&v=2",
  );

  assert.equal(isTimeseriesV2Request(v2Url, "uk_aq_timeseries", flagsOn), true);
  assert.equal(isTimeseriesV2Request(v2Url, "uk_aq_timeseries", flagsOff), false);
  assert.equal(isTimeseriesV2Request(v2Url, "uk_aq_latest", flagsOn), false);

  const normalized = canonicalizeTimeseriesV2RequestUrl(v2Url, false);
  assert.equal(normalized.searchParams.has("cache_bust"), false);
  assert.equal(normalized.searchParams.get("timeseries_id"), "3742");
  assert.equal(normalized.searchParams.get("window"), null, "range request should not include window");
  assert.equal(normalized.searchParams.get("start_utc"), "2026-05-14T10:00:00.000Z");
  assert.equal(normalized.searchParams.get("end_utc"), "2026-05-14T16:00:00.000Z");
  assert.equal(normalized.searchParams.get("format"), "json");
  assert.equal(normalized.searchParams.get("v"), "2");

  const bypassNormalized = canonicalizeTimeseriesV2RequestUrl(v2Url, true);
  assert.equal(bypassNormalized.searchParams.has("cache_bust"), true, "authorized bypass keeps extra params");

  const windowOnly = canonicalizeTimeseriesV2RequestUrl(
    new URL("https://example.test/api/aq/timeseries?timeseries_id=3742&window=7d&v=2"),
    false,
  );
  assert.equal(windowOnly.searchParams.get("window"), "7d");
  assert.equal(windowOnly.searchParams.get("start_utc"), null);

  console.log("timeseries v2 skeleton checks: OK");
}

runChecks();
