import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

const OBSERVS_TIME_ZONE = "Europe/London";

const RPC_SCHEMA = "uk_aq_public";
const RPC_ENSURE_PARTITIONS = "uk_aq_rpc_observs_ensure_daily_partitions";
const RPC_ENFORCE_HOT_COLD_INDEXES = "uk_aq_rpc_observs_enforce_hot_cold_indexes";
const RPC_DEFAULT_DIAGNOSTICS = "uk_aq_rpc_observs_observations_default_diagnostics";
const RPC_DROP_CANDIDATES = "uk_aq_rpc_observs_drop_candidates";
const RPC_DROP_PARTITION = "uk_aq_rpc_observs_drop_partition";

const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

const DEFAULT_FUTURE_PARTITION_DAYS = 3;
const DEFAULT_HOT_PARTITION_DAYS = 3;
const DEFAULT_OBSERVS_RETENTION_DAYS = 14;
const DEFAULT_DEFAULT_TOP_N = 20;
const DEFAULT_DROP_DRY_RUN = false;

const LONDON_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: OBSERVS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const LONDON_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: OBSERVS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function nowIso() {
  return new Date().toISOString();
}

function logStructured(severity, event, details = {}) {
  const entry = {
    severity,
    event,
    timestamp: nowIso(),
    ...details,
  };
  const line = JSON.stringify(entry);
  if (severity === "ERROR") {
    console.error(line);
    return;
  }
  if (severity === "WARNING") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  if (intValue < min) {
    return min;
  }
  if (intValue > max) {
    return max;
  }
  return intValue;
}

function requiredEnvAny(names) {
  for (const name of names) {
    const value = (process.env[name] || "").trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required environment variable: one of ${names.join(", ")}`);
}

function normalizeDropboxPath(raw) {
  const value = (raw || "").trim();
  if (!value) {
    return "";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/, "");
}

function dropboxWithRoot(path) {
  const root = normalizeDropboxPath(process.env.UK_AQ_DROPBOX_ROOT || "");
  const cleaned = normalizeDropboxPath(path);
  if (!root) {
    return cleaned;
  }
  if (!cleaned) {
    return root;
  }
  if (cleaned === root || cleaned.startsWith(`${root}/`)) {
    return cleaned;
  }
  return `${root}${cleaned}`;
}

function observsMaintenanceDropboxFolderPath() {
  const configured = (process.env.UK_AQ_OBSERVS_PARTITION_DROPBOX_FOLDER || "/observs_partition_maintenance").trim();
  const folder = dropboxWithRoot(configured);
  return folder || "/observs_partition_maintenance";
}

function formatCompactUtc(ts) {
  return ts.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildMaintenanceFileName(eventType, createdAt, id) {
  return `uk_aq_${eventType}_${formatCompactUtc(createdAt)}_${id}.json`;
}

async function readResponseText(response, limit = 1000) {
  const raw = await response.text();
  return raw.length <= limit ? raw : raw.slice(0, limit);
}

function shouldUploadDropbox() {
  const allowedUrl = (process.env.UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL || "").trim();
  if (!allowedUrl) {
    return true;
  }
  const candidates = [
    (process.env.OBS_AQIDB_SUPABASE_URL || "").trim(),
    (process.env.OBS_AQIDB_SUPABASE_URL || "").trim(),
    (process.env.SUPABASE_URL || "").trim(),
    (process.env.SB_URL || "").trim(),
  ].filter(Boolean);
  return candidates.includes(allowedUrl);
}

async function dropboxRefreshAccessToken() {
  const appKey = (process.env.DROPBOX_APP_KEY || "").trim();
  const appSecret = (process.env.DROPBOX_APP_SECRET || "").trim();
  const refreshToken = (process.env.DROPBOX_REFRESH_TOKEN || "").trim();

  if (!(appKey && appSecret && refreshToken)) {
    return null;
  }

  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  });
  const tokenResp = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (!tokenResp.ok) {
    const text = await readResponseText(tokenResp);
    throw new Error(`Dropbox token request failed (${tokenResp.status}): ${text}`);
  }
  const tokenJson = await tokenResp.json();
  const accessToken = String(tokenJson?.access_token || "");
  if (!accessToken) {
    throw new Error("Dropbox token response missing access_token.");
  }
  return accessToken;
}

async function uploadJsonToDropbox(payload, dropboxPath) {
  if (!shouldUploadDropbox()) {
    return { uploaded: false, reason: "allowlist_mismatch" };
  }

  const accessToken = await dropboxRefreshAccessToken();
  if (!accessToken) {
    return { uploaded: false, reason: "missing_credentials" };
  }

  const uploadResp = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: JSON.stringify(payload, null, 2),
  });

  if (!uploadResp.ok) {
    const text = await readResponseText(uploadResp);
    throw new Error(`Dropbox upload failed (${uploadResp.status}): ${text}`);
  }

  return { uploaded: true, dropbox_path: dropboxPath };
}

async function uploadMaintenanceLogToDropbox(eventType, payload, createdAt, id) {
  const folder = observsMaintenanceDropboxFolderPath();
  const dateFolder = createdAt.slice(0, 10);
  const fileName = buildMaintenanceFileName(eventType, createdAt, id);
  const dropboxPath = `${folder}/${dateFolder}/${fileName}`;
  return uploadJsonToDropbox(payload, dropboxPath);
}

function utcMidnightFromIsoDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function isoDateFromUtc(date) {
  return date.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate, dayDelta) {
  const date = utcMidnightFromIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return isoDateFromUtc(date);
}

function minIsoDate(a, b) {
  return a <= b ? a : b;
}

function partsToDate(parts) {
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = Number(part.value);
    }
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

function getLondonDateParts(date) {
  const parts = LONDON_DATE_FORMATTER.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = Number(part.value);
    }
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
  };
}

function shiftLocalDateParts(parts, dayDelta) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getTimeZoneOffsetMs(utcInstant, formatter) {
  const local = partsToDate(formatter.formatToParts(utcInstant));
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0);
  return asUtc - utcInstant.getTime();
}

function zonedLocalDateTimeToUtc(localParts, timeZoneFormatter) {
  const localEpochGuess = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour || 0,
    localParts.minute || 0,
    localParts.second || 0,
    0,
  );
  let utcEpoch = localEpochGuess;
  for (let i = 0; i < 3; i += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(utcEpoch), timeZoneFormatter);
    const candidate = localEpochGuess - offsetMs;
    if (candidate === utcEpoch) {
      break;
    }
    utcEpoch = candidate;
  }
  return new Date(utcEpoch);
}

function computeRetentionCutoffUtc(now, retentionDays) {
  const londonToday = getLondonDateParts(now);
  const earliestKeptLocalDate = shiftLocalDateParts(londonToday, -retentionDays);
  return zonedLocalDateTimeToUtc(
    {
      year: earliestKeptLocalDate.year,
      month: earliestKeptLocalDate.month,
      day: earliestKeptLocalDate.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    LONDON_DATE_TIME_FORMATTER,
  );
}

function buildObservsConfig(url) {
  const params = url.searchParams;

  const futurePartitionDays = parsePositiveInt(
    params.get("futureDays") ?? process.env.OBSERVS_PARTITIONS_FUTURE_DAYS,
    DEFAULT_FUTURE_PARTITION_DAYS,
    DEFAULT_FUTURE_PARTITION_DAYS,
    DEFAULT_FUTURE_PARTITION_DAYS,
  );
  const hotPartitionDays = parsePositiveInt(
    params.get("hotDays") ?? process.env.OBSERVS_PARTITIONS_HOT_DAYS,
    DEFAULT_HOT_PARTITION_DAYS,
    1,
    10,
  );
  const observsRetentionDays = parsePositiveInt(
    params.get("retentionDays") ?? process.env.OBS_AQIDB_OBSERVS_RETENTION_DAYS,
    DEFAULT_OBSERVS_RETENTION_DAYS,
    1,
    365,
  );
  const defaultTopN = parsePositiveInt(
    params.get("defaultTopN") ?? process.env.OBSERVS_DEFAULT_TOP_N,
    DEFAULT_DEFAULT_TOP_N,
    1,
    200,
  );
  const dropDryRun = parseBoolean(
    params.get("dropDryRun") ?? process.env.OBSERVS_PARTITION_DROP_DRY_RUN,
    DEFAULT_DROP_DRY_RUN,
  );

  return {
    observsSupabaseUrl: requiredEnvAny(["OBS_AQIDB_SUPABASE_URL"]),
    observsSecretKey: requiredEnvAny(["OBS_AQIDB_SECRET_KEY"]),
    futurePartitionDays,
    hotPartitionDays,
    observsRetentionDays,
    defaultTopN,
    dropDryRun,
    r2: {
      // TODO: wire these env vars via Secret Manager for production.
      endpoint: (process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
      bucket: (process.env.CFLARE_R2_BUCKET || process.env.R2_BUCKET || "").trim(),
      accessKeyId: (process.env.CFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "").trim(),
      secretAccessKey: (process.env.CFLARE_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "").trim(),
      region: (process.env.CFLARE_R2_REGION || process.env.R2_REGION || "auto").trim() || "auto",
      observationsPrefix: (
        process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX
        || "history/v1/observations"
      ).trim().replace(/^\/+|\/+$/g, ""),
    },
  };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function callRpc(client, fnName, params, errorLabel) {
  const { data, error } = await client.rpc(fnName, params);
  if (error) {
    throw new Error(`${errorLabel} failed: ${error.message}`);
  }
  return data || [];
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function awsSha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function awsHmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function awsSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = awsHmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  return awsHmac(kService, "aws4_request");
}

function buildCanonicalQuery(query) {
  const pairs = [];
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    pairs.push([encodeRfc3986(key), encodeRfc3986(String(value))]);
  }
  pairs.sort((a, b) => {
    if (a[0] === b[0]) {
      return a[1].localeCompare(b[1]);
    }
    return a[0].localeCompare(b[0]);
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function buildAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function buildAwsSignedRequest({ method, endpoint, region, accessKeyId, secretAccessKey, bucket, objectKey, query = {} }) {
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const service = "s3";
  const now = new Date();
  const amzDate = buildAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const pathParts = ["", bucket];
  if (objectKey) {
    for (const part of objectKey.split("/").filter(Boolean)) {
      pathParts.push(encodeRfc3986(part));
    }
  }
  const canonicalUri = pathParts.join("/") || "/";
  const canonicalQuery = buildCanonicalQuery(query);
  const payloadHash = awsSha256Hex("");

  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    awsSha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = awsSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  const requestUrl = new URL(endpoint);
  requestUrl.pathname = canonicalUri;
  requestUrl.search = canonicalQuery;

  return {
    url: requestUrl.toString(),
    headers: {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization,
    },
  };
}

function hasRequiredR2Config(r2) {
  return Boolean(r2.endpoint && r2.bucket && r2.accessKeyId && r2.secretAccessKey && r2.region);
}

async function r2HeadDayManifest(r2, dayUtc) {
  const objectKey = `${r2.observationsPrefix}/day_utc=${dayUtc}/manifest.json`;
  const request = buildAwsSignedRequest({
    method: "HEAD",
    endpoint: r2.endpoint,
    region: r2.region,
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    bucket: r2.bucket,
    objectKey,
  });

  const response = await fetch(request.url, {
    method: "HEAD",
    headers: request.headers,
  });

  if (response.status === 200) {
    return {
      confirmed: true,
      method: "head_day_manifest",
      manifest_key: objectKey,
    };
  }

  const body = await readResponseText(response, 500);
  return {
    confirmed: false,
    method: "head_day_manifest",
    manifest_key: objectKey,
    status: response.status,
    response_text: body,
  };
}

async function r2GetManifestJson(r2, manifestKey) {
  const request = buildAwsSignedRequest({
    method: "GET",
    endpoint: r2.endpoint,
    region: r2.region,
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    bucket: r2.bucket,
    objectKey: manifestKey,
  });

  const response = await fetch(request.url, {
    method: "GET",
    headers: request.headers,
  });

  if (response.status !== 200) {
    const body = await readResponseText(response, 500);
    return {
      confirmed: false,
      method: "get_day_manifest",
      manifest_key: manifestKey,
      status: response.status,
      response_text: body,
    };
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    return {
      confirmed: false,
      method: "get_day_manifest",
      manifest_key: manifestKey,
      status: response.status,
      reason: "manifest_read_error",
    };
  }

  let manifest = null;
  try {
    manifest = JSON.parse(text);
  } catch {
    return {
      confirmed: false,
      method: "get_day_manifest",
      manifest_key: manifestKey,
      status: response.status,
      reason: "manifest_invalid_json",
      response_text: text.slice(0, 500),
    };
  }

  return {
    confirmed: true,
    method: "get_day_manifest",
    manifest_key: manifestKey,
    status: response.status,
    manifest,
  };
}

function validateManifestHash(dayUtc, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      confirmed: false,
      reason: "manifest_not_object",
    };
  }

  const manifestDayUtc = typeof manifest.day_utc === "string"
    ? manifest.day_utc.trim()
    : "";
  if (manifestDayUtc !== dayUtc) {
    return {
      confirmed: false,
      reason: "manifest_day_mismatch",
      manifest_day_utc: manifestDayUtc || null,
      expected_day_utc: dayUtc,
    };
  }

  const storedManifestHash = typeof manifest.manifest_hash === "string"
    ? manifest.manifest_hash.trim()
    : "";
  if (!storedManifestHash) {
    return {
      confirmed: false,
      reason: "manifest_hash_missing",
    };
  }

  const payloadWithoutHash = { ...manifest };
  delete payloadWithoutHash.manifest_hash;

  const recomputedManifestHash = awsSha256Hex(JSON.stringify(payloadWithoutHash));
  if (recomputedManifestHash !== storedManifestHash) {
    return {
      confirmed: false,
      reason: "manifest_hash_mismatch",
      expected_manifest_hash: recomputedManifestHash,
      actual_manifest_hash: storedManifestHash,
    };
  }

  const sourceRowCount = Number(manifest.source_row_count ?? 0);
  const fileCount = Number(manifest.file_count ?? 0);
  return {
    confirmed: true,
    method: "manifest_hash_validated",
    day_utc: manifestDayUtc,
    source_row_count: Number.isFinite(sourceRowCount) ? Math.max(0, Math.trunc(sourceRowCount)) : 0,
    file_count: Number.isFinite(fileCount) ? Math.max(0, Math.trunc(fileCount)) : 0,
    manifest_hash: storedManifestHash,
  };
}

async function historyManifestExists(dayUtc, r2) {
  if (!hasRequiredR2Config(r2)) {
    return {
      confirmed: false,
      reason: "missing_r2_configuration",
    };
  }

  try {
    const headResult = await r2HeadDayManifest(r2, dayUtc);
    if (!headResult.confirmed) {
      return {
        confirmed: false,
        reason: "history_manifest_not_confirmed",
        details: headResult,
      };
    }

    const getResult = await r2GetManifestJson(r2, headResult.manifest_key);
    if (!getResult.confirmed) {
      return {
        confirmed: false,
        reason: "history_manifest_not_confirmed",
        details: getResult,
      };
    }

    const validationResult = validateManifestHash(dayUtc, getResult.manifest);
    if (!validationResult.confirmed) {
      return {
        confirmed: false,
        reason: "history_manifest_not_confirmed",
        details: {
          method: "validate_day_manifest_hash",
          manifest_key: headResult.manifest_key,
          ...validationResult,
        },
      };
    }

    return {
      confirmed: true,
      method: "head_get_validate_manifest_hash",
      details: {
        method: "head_get_validate_manifest_hash",
        manifest_key: headResult.manifest_key,
        day_utc: validationResult.day_utc,
        source_row_count: validationResult.source_row_count,
        file_count: validationResult.file_count,
        manifest_hash: validationResult.manifest_hash,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      confirmed: false,
      reason: "history_manifest_check_error",
      details: {
        error: message,
      },
    };
  }
}

function normalizeDropCandidate(row) {
  return {
    partition_name: String(row.partition_name || "").trim(),
    partition_day_utc: String(row.partition_day_utc || "").slice(0, 10),
    partition_start_utc: String(row.partition_start_utc || ""),
    partition_end_utc: String(row.partition_end_utc || ""),
  };
}

function parseDefaultDiagnosticsRow(row) {
  const count = Number(row?.default_row_count ?? 0);
  const topOffenders = Array.isArray(row?.top_offenders)
    ? row.top_offenders
    : (row?.top_offenders && typeof row.top_offenders === "object" ? row.top_offenders : []);
  return {
    default_row_count: Number.isFinite(count) ? count : 0,
    min_observed_at: row?.min_observed_at || null,
    max_observed_at: row?.max_observed_at || null,
    top_offenders: Array.isArray(topOffenders) ? topOffenders : [],
  };
}

async function runObservsPartitionMaintenance(config) {
  const runId = randomUUID();
  const observsClient = createClient(config.observsSupabaseUrl, config.observsSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });

  const now = new Date();
  const todayUtc = isoDateFromUtc(new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  )));
  const futureEndDayUtc = shiftIsoDate(todayUtc, config.futurePartitionDays);
  const hotEndDayUtc = futureEndDayUtc;
  const hotStartDayUtc = shiftIsoDate(todayUtc, -(config.hotPartitionDays - 1));

  const retentionCutoffUtc = computeRetentionCutoffUtc(now, config.observsRetentionDays);
  const retentionCutoffIso = retentionCutoffUtc.toISOString();
  const cutoffFloorDayUtc = retentionCutoffIso.slice(0, 10);
  const ensureStartDayUtc = minIsoDate(hotStartDayUtc, cutoffFloorDayUtc);

  logStructured("INFO", "observs_partition_maintenance_run_start", {
    run_id: runId,
    now_utc: now.toISOString(),
    hot_start_day_utc: hotStartDayUtc,
    hot_end_day_utc: hotEndDayUtc,
    ensure_start_day_utc: ensureStartDayUtc,
    ensure_end_day_utc: futureEndDayUtc,
    observs_retention_days: config.observsRetentionDays,
    retention_cutoff_utc: retentionCutoffIso,
    drop_dry_run: config.dropDryRun,
  });

  const ensured = await callRpc(
    observsClient,
    RPC_ENSURE_PARTITIONS,
    {
      start_day_utc: ensureStartDayUtc,
      end_day_utc: futureEndDayUtc,
    },
    "observs ensure daily partitions",
  );

  const enforceResults = await callRpc(
    observsClient,
    RPC_ENFORCE_HOT_COLD_INDEXES,
    {
      hot_start_day_utc: hotStartDayUtc,
      hot_end_day_utc: hotEndDayUtc,
    },
    "observs enforce hot/cold indexes",
  );

  const diagnosticsRows = await callRpc(
    observsClient,
    RPC_DEFAULT_DIAGNOSTICS,
    {
      top_n: config.defaultTopN,
    },
    "observs default partition diagnostics",
  );
  const defaultDiagnostics = parseDefaultDiagnosticsRow(diagnosticsRows[0]);

  let defaultDropboxUpload = { uploaded: false, reason: "not_required" };
  if (defaultDiagnostics.default_row_count > 0) {
    const payload = {
      run_id: runId,
      event: "default_partition_non_zero",
      generated_at: nowIso(),
      diagnostics: defaultDiagnostics,
    };
    logStructured("WARNING", "observs_default_partition_non_zero", {
      run_id: runId,
      default_row_count: defaultDiagnostics.default_row_count,
      min_observed_at: defaultDiagnostics.min_observed_at,
      max_observed_at: defaultDiagnostics.max_observed_at,
      top_offenders: defaultDiagnostics.top_offenders,
    });

    try {
      defaultDropboxUpload = await uploadMaintenanceLogToDropbox(
        "observs_default_partition_alert",
        payload,
        nowIso(),
        randomUUID(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      defaultDropboxUpload = {
        uploaded: false,
        reason: "upload_failed",
        upload_error: message,
      };
      logStructured("ERROR", "observs_default_partition_dropbox_upload_failed", {
        run_id: runId,
        message,
      });
    }
  }

  const dropCandidates = (await callRpc(
    observsClient,
    RPC_DROP_CANDIDATES,
    {
      cutoff_utc: retentionCutoffIso,
    },
    "observs drop candidates",
  )).map(normalizeDropCandidate);

  const dropped = [];
  const skipped = [];

  for (const candidate of dropCandidates) {
    if (!candidate.partition_name || !candidate.partition_day_utc) {
      continue;
    }

    if (config.dropDryRun) {
      const skip = {
        partition_name: candidate.partition_name,
        partition_day_utc: candidate.partition_day_utc,
        reason: "drop_dry_run",
      };
      skipped.push(skip);
      logStructured("INFO", "observs_partition_drop_dry_run_skip", {
        run_id: runId,
        ...skip,
      });
      continue;
    }

    const historyManifestCheck = await historyManifestExists(candidate.partition_day_utc, config.r2);
    if (!historyManifestCheck.confirmed) {
      const skipId = randomUUID();
      const createdAt = nowIso();
      const skipPayload = {
        run_id: runId,
        event: "observs_partition_drop_skipped_history_manifest_not_confirmed",
        message: "SKIP DROP — history manifest not confirmed",
        partition: candidate,
        history_manifest_check: historyManifestCheck,
        created_at: createdAt,
      };

      const skipDropboxResult = await (async () => {
        try {
          return await uploadMaintenanceLogToDropbox(
            "observs_partition_skip_drop",
            skipPayload,
            createdAt,
            skipId,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            uploaded: false,
            reason: "upload_failed",
            upload_error: message,
          };
        }
      })();

      const skip = {
        partition_name: candidate.partition_name,
        partition_day_utc: candidate.partition_day_utc,
        reason: "history_manifest_not_confirmed",
        history_manifest_check: historyManifestCheck,
        dropbox_uploaded: Boolean(skipDropboxResult.uploaded),
        dropbox_path: skipDropboxResult.dropbox_path || null,
        dropbox_reason: skipDropboxResult.reason || null,
      };
      skipped.push(skip);

      logStructured("WARNING", "observs_partition_drop_skipped", {
        run_id: runId,
        message: "SKIP DROP — history manifest not confirmed",
        ...skip,
      });
      continue;
    }

    const dropResultRows = await callRpc(
      observsClient,
      RPC_DROP_PARTITION,
      {
        p_partition_name: candidate.partition_name,
      },
      `drop observs partition ${candidate.partition_name}`,
    );
    const didDrop = Boolean(dropResultRows?.[0]?.dropped);
    if (didDrop) {
      dropped.push({
        partition_name: candidate.partition_name,
        partition_day_utc: candidate.partition_day_utc,
        history_manifest_method: historyManifestCheck.method,
      });
      logStructured("INFO", "observs_partition_dropped", {
        run_id: runId,
        partition_name: candidate.partition_name,
        partition_day_utc: candidate.partition_day_utc,
        history_manifest_method: historyManifestCheck.method,
      });
    } else {
      const skip = {
        partition_name: candidate.partition_name,
        partition_day_utc: candidate.partition_day_utc,
        reason: "drop_rpc_returned_false",
      };
      skipped.push(skip);
      logStructured("WARNING", "observs_partition_drop_not_applied", {
        run_id: runId,
        ...skip,
      });
    }
  }

  const summary = {
    run_id: runId,
    now_utc: now.toISOString(),
    hot_start_day_utc: hotStartDayUtc,
    hot_end_day_utc: hotEndDayUtc,
    ensure_start_day_utc: ensureStartDayUtc,
    ensure_end_day_utc: futureEndDayUtc,
    retention_cutoff_utc: retentionCutoffIso,
    observs_retention_days: config.observsRetentionDays,
    drop_dry_run: config.dropDryRun,
    ensured_partition_count: ensured.length,
    ensured_partitions_preview: ensured.slice(0, 25),
    index_enforcement_count: enforceResults.length,
    index_enforcement_preview: enforceResults.slice(0, 25),
    default_partition_diagnostics: defaultDiagnostics,
    default_partition_dropbox_upload: defaultDropboxUpload,
    drop_candidate_count: dropCandidates.length,
    dropped_count: dropped.length,
    skipped_count: skipped.length,
    dropped_preview: dropped.slice(0, 50),
    skipped_preview: skipped.slice(0, 50),
  };

  logStructured("INFO", "observs_partition_maintenance_run_summary", summary);
  return summary;
}

const server = createServer(async (req, res) => {
  let requestPath = "/";
  let requestQuery = "";

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    requestPath = url.pathname;
    requestQuery = url.search || "";

    if (url.pathname === "/healthz") {
      jsonResponse(res, 200, { ok: true, now: nowIso() });
      return;
    }

    if (url.pathname !== "/run") {
      jsonResponse(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "method_not_allowed", message: "Use POST /run" });
      return;
    }

    const config = buildObservsConfig(url);
    const summary = await runObservsPartitionMaintenance(config);
    jsonResponse(res, 200, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack || null : null;
    const errorId = randomUUID();
    const createdAt = nowIso();

    const payload = {
      id: errorId,
      created_at: createdAt,
      source: "cloud_run_observs_partition_maintenance",
      severity: "error",
      message,
      stack,
      context: {
        request_method: req.method || "",
        request_path: requestPath,
        request_query: requestQuery,
        host: req.headers.host || "",
        user_agent: req.headers["user-agent"] || "",
      },
    };

    const dropboxResult = await (async () => {
      try {
        return await uploadMaintenanceLogToDropbox(
          "observs_partition_service_error",
          payload,
          createdAt,
          errorId,
        );
      } catch (uploadError) {
        const uploadMessage = uploadError instanceof Error
          ? uploadError.message
          : String(uploadError);
        return {
          uploaded: false,
          reason: "upload_failed",
          upload_error: uploadMessage,
        };
      }
    })();

    logStructured("ERROR", "observs_partition_maintenance_run_error", {
      error_id: errorId,
      message,
      request_method: req.method || "",
      request_path: requestPath,
      dropbox_uploaded: Boolean(dropboxResult.uploaded),
      dropbox_path: dropboxResult.dropbox_path || null,
      dropbox_reason: dropboxResult.reason || null,
    });

    jsonResponse(res, 500, {
      error: "observs_partition_maintenance_run_error",
      message: "Internal error. See logs with error_id.",
      error_id: errorId,
      dropbox_uploaded: Boolean(dropboxResult.uploaded),
      dropbox_path: dropboxResult.dropbox_path || null,
    });
  }
});

const port = parsePositiveInt(process.env.PORT, 8080, 1, 65535);
server.listen(port, () => {
  logStructured("INFO", "observs_partition_maintenance_service_started", {
    port,
    defaults: {
      future_partition_days: DEFAULT_FUTURE_PARTITION_DAYS,
      hot_partition_days: DEFAULT_HOT_PARTITION_DAYS,
      observs_retention_days: DEFAULT_OBSERVS_RETENTION_DAYS,
      default_top_n: DEFAULT_DEFAULT_TOP_N,
      drop_dry_run: DEFAULT_DROP_DRY_RUN,
    },
  });
});
