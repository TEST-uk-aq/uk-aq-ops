import {
  r2DeleteObjects,
  r2GetObject,
  r2ListAllCommonPrefixes,
  r2PutObject,
} from "./r2_sigv4.mjs";
import {
  OBSERVATIONS_AGGREGATE_MANIFEST_KINDS,
  buildR2HistoryV2ObservationsMonthManifest,
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifest,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "./uk_aq_r2_observations_manifest_hierarchy.mjs";

const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePrefix(raw = DEFAULT_OBSERVATIONS_PREFIX) {
  const prefix = String(raw || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid observations hierarchy prefix: ${String(raw || "")}`);
  }
  return prefix;
}

function normalizeDay(raw) {
  const day = String(raw || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!ISO_DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid observations hierarchy affected day: ${String(raw || "")}`);
  }
  return day;
}

function normalizeAffectedDays(values) {
  if (!Array.isArray(values)) throw new Error("affectedDaysUtc must be an array");
  return [...new Set(values.map(normalizeDay))].sort();
}

function isMissing(error) {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status !== undefined && status !== null && status !== "") return Number(status) === 404;
  const code = String(error?.code || error?.name || "").toLowerCase();
  if (["nosuchkey", "no_such_key", "notfound", "not_found"].includes(code)) return true;
  return /^R2 GET failed \(404\) key=/.test(String(error instanceof Error ? error.message : error || ""));
}

function parseJson(result, key) {
  try {
    return JSON.parse(Buffer.from(result.body).toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dayReference(payload, key, prefix) {
  const match = key.match(new RegExp(`^${escapeRegex(prefix)}/day_utc=(\\d{4}-\\d{2}-\\d{2})/manifest\\.json$`));
  if (!match) throw new Error(`Unexpected observation day manifest key: ${key}`);
  const dayUtc = match[1];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Day manifest is not a JSON object: ${key}`);
  }
  if (payload.day_utc !== dayUtc || payload.manifest_key !== key) {
    throw new Error(`Day manifest identity mismatch: ${key}`);
  }
  if (payload.domain !== undefined && payload.domain !== "observations") {
    throw new Error(`Day manifest domain mismatch: ${key}`);
  }
  if (payload.manifest_kind !== undefined && payload.manifest_kind !== "day") {
    throw new Error(`Day manifest kind mismatch: ${key}`);
  }
  const manifestHash = String(payload.manifest_hash || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(manifestHash)) throw new Error(`Invalid day manifest_hash: ${key}`);
  return { day_utc: dayUtc, manifest_key: key, manifest_hash: manifestHash };
}

function assertAggregateIdentity(manifest, { level, key, prefix, year = null, month = null }) {
  if (manifest.kind !== OBSERVATIONS_AGGREGATE_MANIFEST_KINDS[level]) {
    throw new Error(`Observations ${level} manifest kind mismatch: ${key}`);
  }
  if (level === "month") {
    if (
      key !== buildR2HistoryV2ObservationsMonthManifestKey(prefix, year, month)
      || manifest.year !== Number(year)
      || manifest.month !== String(month).padStart(2, "0")
    ) throw new Error(`Observations month manifest identity mismatch: ${key}`);
  } else if (level === "year") {
    if (
      key !== buildR2HistoryV2ObservationsYearManifestKey(prefix, year)
      || manifest.year !== Number(year)
    ) throw new Error(`Observations year manifest identity mismatch: ${key}`);
  } else if (key !== buildR2HistoryV2ObservationsRootManifestKey(prefix)) {
    throw new Error(`Observations root manifest identity mismatch: ${key}`);
  }
}

async function readAggregate({ io, r2, key, prefix, level, year = null, month = null, allowMissing = false }) {
  let object;
  try {
    object = await io.getObject({ r2, key });
  } catch (error) {
    if (allowMissing && isMissing(error)) return null;
    throw error;
  }
  const body = Buffer.from(object.body);
  const canonical = validateR2HistoryV2ObservationsAggregateManifest(parseJson(object, key), {
    basePrefix: prefix,
  });
  assertAggregateIdentity(canonical, { level, key, prefix, year, month });
  const canonicalBody = serializeR2HistoryV2ObservationsAggregateManifest(canonical, {
    basePrefix: prefix,
  });
  if (Buffer.compare(body, canonicalBody) !== 0) {
    throw new Error(`Observations aggregate manifest is not byte-canonical: ${key}`);
  }
  return { canonical, body, bytes: Number(object.bytes ?? body.byteLength) };
}

async function planAndWrite({ io, r2, prefix, level, key, manifest, identity, writeR2 }) {
  const body = serializeR2HistoryV2ObservationsAggregateManifest(manifest, { basePrefix: prefix });
  let existing = null;
  let validationError = null;
  try {
    existing = await readAggregate({
      io,
      r2,
      key,
      prefix,
      level,
      ...identity,
      allowMissing: true,
    });
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }
  const action = !existing && !validationError
    ? "create"
    : validationError
      ? "replace_invalid"
      : Buffer.compare(existing.body, body) === 0
        ? "unchanged"
        : "update";
  let write = null;
  if (writeR2 && action !== "unchanged") {
    const put = await io.putObject({
      r2,
      key,
      body,
      content_type: "application/json; charset=utf-8",
    });
    const verified = await readAggregate({ io, r2, key, prefix, level, ...identity });
    if (Buffer.compare(verified.body, body) !== 0) {
      throw new Error(`R2 observations hierarchy read-back verification failed: ${key}`);
    }
    write = {
      level,
      key,
      action,
      bytes: verified.bytes,
      etag: put?.etag ?? null,
      verified: true,
    };
  }
  return {
    public: {
      level,
      key,
      action,
      existing_found: Boolean(existing || validationError),
      existing_bytes: existing?.bytes ?? 0,
      existing_content_hash: existing?.canonical.content_hash ?? null,
      desired_content_hash: manifest.content_hash,
      validation_error: validationError,
    },
    child: { ...manifest, manifest_key: key },
    write,
  };
}

async function loadMonthChildrenFromYear({ io, r2, prefix, year, overlays, allowEmpty = false }) {
  const yearKey = buildR2HistoryV2ObservationsYearManifestKey(prefix, year);
  const existingYear = await readAggregate({
    io,
    r2,
    key: yearKey,
    prefix,
    level: "year",
    year,
    allowMissing: true,
  });
  const children = new Map();
  for (const reference of existingYear?.canonical.children || []) {
    const key = reference.manifest_key;
    if (overlays.has(key)) continue;
    const month = await readAggregate({
      io,
      r2,
      key,
      prefix,
      level: "month",
      year,
      month: reference.month,
    });
    if (month.canonical.content_hash !== reference.content_hash) {
      throw new Error(`Year child hash mismatch for ${key}`);
    }
    children.set(key, { ...month.canonical, manifest_key: key });
  }
  for (const [key, manifest] of overlays) {
    if (manifest && String(manifest.year) === String(year)) children.set(key, manifest);
  }
  if (!children.size && !allowEmpty) {
    throw new Error(`No observations month manifests found for year ${year}`);
  }
  return [...children.values()];
}

async function loadYearChildrenFromRoot({ io, r2, prefix, overlays }) {
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  const root = await readAggregate({ io, r2, key: rootKey, prefix, level: "root" });
  const children = new Map();
  for (const reference of root.canonical.children) {
    const key = reference.manifest_key;
    if (overlays.has(key)) continue;
    const year = await readAggregate({
      io,
      r2,
      key,
      prefix,
      level: "year",
      year: reference.year,
    });
    if (year.canonical.content_hash !== reference.content_hash) {
      throw new Error(`Root child hash mismatch for ${key}`);
    }
    children.set(key, { ...year.canonical, manifest_key: key });
  }
  for (const [key, manifest] of overlays) {
    if (manifest) children.set(key, manifest);
  }
  return [...children.values()];
}

export async function finalizeR2HistoryV2ObservationsManifestHierarchy({
  r2,
  observationsPrefix = DEFAULT_OBSERVATIONS_PREFIX,
  affectedDaysUtc,
  maxKeys = 1000,
  writeR2 = true,
  absentAffectedDaysUtc = [],
  adapters = {},
}) {
  if (!r2 || typeof r2 !== "object") throw new Error("Observations hierarchy finaliser requires R2 configuration");
  const prefix = normalizePrefix(observationsPrefix);
  const days = normalizeAffectedDays(affectedDaysUtc);
  const absentDays = normalizeAffectedDays(absentAffectedDaysUtc);
  if (absentDays.some((day) => !days.includes(day))) {
    throw new Error("Approved absent observation days must be affected days");
  }
  const allowMissingAffectedDays = absentDays.length > 0;
  if (!Number.isSafeInteger(Number(maxKeys)) || Number(maxKeys) <= 0) throw new Error("maxKeys must be a positive integer");
  if (typeof writeR2 !== "boolean") throw new Error("writeR2 must be boolean");
  if (days.length === 0) {
    return {
      ok: true,
      status: "skipped",
      reason: "no_affected_days",
      affected_days_utc: [],
      affected_months: [],
      affected_years: [],
      objects: [],
      execution: { wrote_object_count: 0, writes: [] },
    };
  }
  const io = {
    getObject: adapters.getObject || r2GetObject,
    listAllCommonPrefixes: adapters.listAllCommonPrefixes || r2ListAllCommonPrefixes,
    putObject: adapters.putObject || r2PutObject,
    deleteObjects: adapters.deleteObjects || r2DeleteObjects,
  };
  const affectedMonths = [...new Set(days.map((day) => day.slice(0, 7)))].sort();
  const affectedYears = [...new Set(affectedMonths.map((value) => value.slice(0, 4)))].sort();
  const topLevel = await io.listAllCommonPrefixes({
    r2,
    prefix: `${prefix}/`,
    delimiter: "/",
    max_keys: Number(maxKeys),
  });
  const dayKeys = topLevel.flatMap((raw) => {
    const match = String(raw || "").match(new RegExp(`^${escapeRegex(prefix)}/day_utc=(\\d{4}-\\d{2}-\\d{2})/$`));
    return match ? [`${prefix}/day_utc=${match[1]}/manifest.json`] : [];
  }).sort();
  const objects = [];
  const writes = [];
  const deferred = [];
  const monthOverlays = new Map();
  for (const yearMonth of affectedMonths) {
    const [year, month] = yearMonth.split("-");
    const key = buildR2HistoryV2ObservationsMonthManifestKey(prefix, year, month);
    const existingMonth = await readAggregate({
      io, r2, key, prefix, level: "month", year, month, allowMissing: true,
    });
    // Required children come from authority, independently of LIST completeness.
    const requiredDayKeys = new Set([
      ...(existingMonth?.canonical.children || []).map((child) => child.manifest_key),
      ...days.filter((day) => day.startsWith(`${yearMonth}-`))
        .map((day) => `${prefix}/day_utc=${day}/manifest.json`),
    ]);
    const approvedAbsentDayKeys = new Set(absentDays.filter((day) => day.startsWith(`${yearMonth}-`))
      .map((day) => `${prefix}/day_utc=${day}/manifest.json`));
    if (allowMissingAffectedDays) {
      const unexpectedDays = dayKeys.filter((value) => value.includes(`/day_utc=${yearMonth}-`)
        && !requiredDayKeys.has(value));
      if (unexpectedDays.length) {
        throw new Error(`Uncommitted observation day cannot enter an empty-day finalisation: ${unexpectedDays[0]}`);
      }
    }
    const candidateDayKeys = [...new Set([
      ...requiredDayKeys,
      ...dayKeys.filter((value) => value.includes(`/day_utc=${yearMonth}-`)),
    ])].sort();
    const references = [];
    for (const dayKey of candidateDayKeys) {
      let object;
      try {
        object = await io.getObject({ r2, key: dayKey });
      } catch (error) {
        if (allowMissingAffectedDays && approvedAbsentDayKeys.has(dayKey) && isMissing(error)) continue;
        // Interrupted publication can leave an uncommitted, discovery-only prefix.
        if (!requiredDayKeys.has(dayKey) && isMissing(error)) continue;
        throw error;
      }
      references.push(dayReference(parseJson(object, dayKey), dayKey, prefix));
    }
    if (references.length === 0 && approvedAbsentDayKeys.size) {
      if (existingMonth) {
        objects.push({ level: "month", key, action: "remove", existing_found: true,
          existing_content_hash: existingMonth.canonical.content_hash,
          desired_content_hash: null });
        deferred.push({ level: "month", key, action: "remove" });
      }
      monthOverlays.set(key, null);
      continue;
    }
    if (references.length === 0) throw new Error(`No committed observation day manifests found for ${yearMonth}`);
    const manifest = buildR2HistoryV2ObservationsMonthManifest({
      basePrefix: prefix,
      year,
      month,
      dayManifests: references,
    });
    const result = await planAndWrite({
      io,
      r2,
      prefix,
      level: "month",
      key,
      manifest,
      identity: { year, month },
      writeR2: writeR2 && !allowMissingAffectedDays,
    });
    objects.push(result.public);
    if (allowMissingAffectedDays && result.public.action !== "unchanged") {
      deferred.push({ level: "month", key, action: "put", manifest, identity: { year, month } });
    }
    monthOverlays.set(key, result.child);
    if (result.write) writes.push(result.write);
  }

  const yearOverlays = new Map();
  for (const year of affectedYears) {
    const monthManifests = await loadMonthChildrenFromYear({
      io,
      r2,
      prefix,
      year,
      overlays: monthOverlays,
      allowEmpty: allowMissingAffectedDays,
    });
    const key = buildR2HistoryV2ObservationsYearManifestKey(prefix, year);
    if (allowMissingAffectedDays && !monthManifests.length) {
      const existingYear = await readAggregate({ io, r2, key, prefix, level: "year", year, allowMissing: true });
      if (existingYear) {
        objects.push({ level: "year", key, action: "remove", existing_found: true,
          existing_content_hash: existingYear.canonical.content_hash,
          desired_content_hash: null });
        deferred.push({ level: "year", key, action: "remove" });
      }
      yearOverlays.set(key, null);
      continue;
    }
    const manifest = buildR2HistoryV2ObservationsYearManifest({
      basePrefix: prefix,
      year,
      monthManifests,
    });
    const result = await planAndWrite({
      io,
      r2,
      prefix,
      level: "year",
      key,
      manifest,
      identity: { year },
      writeR2: writeR2 && !allowMissingAffectedDays,
    });
    objects.push(result.public);
    if (allowMissingAffectedDays && result.public.action !== "unchanged") {
      deferred.push({ level: "year", key, action: "put", manifest, identity: { year } });
    }
    yearOverlays.set(key, result.child);
    if (result.write) writes.push(result.write);
  }

  const yearManifests = await loadYearChildrenFromRoot({
    io,
    r2,
    prefix,
    overlays: yearOverlays,
  });
  if (allowMissingAffectedDays && !yearManifests.length) {
    throw new Error("An empty observations root is outside the accepted canonical schema");
  }
  const rootManifest = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: prefix,
    yearManifests,
  });
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  const root = await planAndWrite({
    io,
    r2,
    prefix,
    level: "root",
    key: rootKey,
    manifest: rootManifest,
    identity: {},
    writeR2: writeR2 && !allowMissingAffectedDays,
  });
  objects.push(root.public);
  if (allowMissingAffectedDays && root.public.action !== "unchanged") {
    deferred.push({ level: "root", key: rootKey, action: "put", manifest: rootManifest, identity: {} });
  }
  if (root.write) writes.push(root.write);

  // Empty-day finalisation is planned through the root before its first
  // aggregate mutation. The accepted root schema cannot express zero years.
  if (allowMissingAffectedDays && writeR2) {
    for (const job of deferred) {
      if (job.action === "remove") {
        const result = await io.deleteObjects({ r2, keys: [job.key] });
        if (result?.errors?.length) throw new Error(`Observations aggregate deletion failed: ${job.key}`);
        const remaining = await readAggregate({ io, r2, key: job.key, prefix,
          level: job.level, ...job.identity, allowMissing: true });
        if (remaining) throw new Error(`Observations aggregate deletion read-back failed: ${job.key}`);
        writes.push({ level: job.level, key: job.key, action: "remove", verified: true });
      } else {
        const body = serializeR2HistoryV2ObservationsAggregateManifest(job.manifest, { basePrefix: prefix });
        const put = await io.putObject({ r2, key: job.key, body,
          content_type: "application/json; charset=utf-8" });
        const verified = await readAggregate({ io, r2, key: job.key, prefix,
          level: job.level, ...job.identity });
        if (Buffer.compare(verified.body, body) !== 0) {
          throw new Error(`Observations aggregate read-back verification failed: ${job.key}`);
        }
        writes.push({ level: job.level, key: job.key, action: "put", bytes: verified.bytes,
          etag: put?.etag ?? null, verified: true });
      }
    }
  }

  const planning = {
    create: objects.filter((entry) => entry.action === "create").length,
    update: objects.filter((entry) => entry.action === "update").length,
    replace_invalid: objects.filter((entry) => entry.action === "replace_invalid").length,
    unchanged: objects.filter((entry) => entry.action === "unchanged").length,
  };
  if (allowMissingAffectedDays) {
    planning.remove = objects.filter((entry) => entry.action === "remove").length;
  }
  planning.change_count = planning.create + planning.update + planning.replace_invalid
    + (planning.remove || 0);
  planning.expected_object_count = objects.length;
  return {
    ok: true,
    status: writeR2
      ? (planning.change_count ? "written" : "up_to_date")
      : (planning.change_count ? "changes_planned" : "up_to_date"),
    write_r2: writeR2,
    bucket: r2.bucket ?? null,
    observations_prefix: prefix,
    affected_days_utc: days,
    affected_months: affectedMonths,
    affected_years: affectedYears,
    root_content_hash: rootManifest.content_hash,
    planning,
    objects,
    execution: { wrote_object_count: writes.length, writes },
  };
}
