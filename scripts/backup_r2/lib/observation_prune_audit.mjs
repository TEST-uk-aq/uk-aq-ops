const PRUNE_AUDIT_STATE_ROOT =
  "_ops/checkpoints/r2_history_backup_state_v2/observation_prune_audit";
const PRUNE_AUDIT_SCHEMA_VERSION = 1;
const PRUNE_AUDIT_KIND =
  "uk_aq_r2_history_backup_observation_prune_audit_month";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeYear(value) {
  const year = String(value || "").trim();
  if (!/^\d{4}$/.test(year)) throw new Error(`Invalid prune-audit year: ${year}`);
  return year;
}

function normalizeMonth(value) {
  const month = String(value || "").trim().padStart(2, "0");
  if (!/^(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error(`Invalid prune-audit month: ${month}`);
  }
  return month;
}

function normalizeDayUtc(value) {
  const dayUtc = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(dayUtc)) {
    throw new Error(`Invalid prune-audit day_utc: ${dayUtc}`);
  }
  const parsed = new Date(`${dayUtc}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dayUtc) {
    throw new Error(`Invalid prune-audit day_utc: ${dayUtc}`);
  }
  return dayUtc;
}

function normalizeManifestHash(value, label = "prune-audit manifest_hash") {
  const manifestHash = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestHash)) {
    throw new Error(`${label} must be a lowercase SHA-256 value`);
  }
  return manifestHash;
}

function normalizeUtcTimestamp(value) {
  const timestamp = String(value || "").trim();
  const parsed = Date.parse(timestamp);
  if (!timestamp.endsWith("Z") || Number.isNaN(parsed)) {
    throw new Error("prune-audit last_successful_audit_at must be a UTC timestamp");
  }
  return new Date(parsed).toISOString();
}

function normalizeAuditDay(entry, year = null, month = null) {
  const value = requireObject(entry, "prune-audit day checkpoint");
  const dayUtc = normalizeDayUtc(value.day_utc);
  if (year !== null && month !== null && !dayUtc.startsWith(`${year}-${month}-`)) {
    throw new Error(`Prune-audit day ${dayUtc} is outside ${year}-${month}`);
  }
  return {
    day_utc: dayUtc,
    manifest_hash: normalizeManifestHash(value.manifest_hash),
    last_successful_audit_at: normalizeUtcTimestamp(
      value.last_successful_audit_at,
    ),
  };
}

function mapUniqueByDay(entries, label) {
  const result = new Map();
  for (const entry of entries) {
    const dayUtc = normalizeDayUtc(entry.day_utc);
    if (result.has(dayUtc)) throw new Error(`${label} contains duplicate ${dayUtc}`);
    result.set(dayUtc, entry);
  }
  return result;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function observationPruneAuditMonthShardKey(year, month) {
  return `${PRUNE_AUDIT_STATE_ROOT}/year=${normalizeYear(year)}`
    + `/month=${normalizeMonth(month)}.json`;
}

export function emptyObservationPruneAuditMonthState(year, month) {
  return {
    schema_version: PRUNE_AUDIT_SCHEMA_VERSION,
    kind: PRUNE_AUDIT_KIND,
    backup_version: "v2",
    domain: "observation_prune_audit",
    year: normalizeYear(year),
    month: normalizeMonth(month),
    days: [],
  };
}

export function validateObservationPruneAuditMonthState(state, year, month) {
  if (state === null || state === undefined) {
    return emptyObservationPruneAuditMonthState(year, month);
  }
  const value = requireObject(state, "observation prune-audit month state");
  if (
    Number(value.schema_version) !== PRUNE_AUDIT_SCHEMA_VERSION
    || value.kind !== PRUNE_AUDIT_KIND
    || value.backup_version !== "v2"
    || value.domain !== "observation_prune_audit"
  ) {
    throw new Error("Observation prune-audit month state identity mismatch");
  }
  const normalizedYear = normalizeYear(year);
  const normalizedMonth = normalizeMonth(month);
  if (
    normalizeYear(value.year) !== normalizedYear
    || normalizeMonth(value.month) !== normalizedMonth
  ) {
    throw new Error("Observation prune-audit month state path identity mismatch");
  }
  if (!Array.isArray(value.days)) {
    throw new Error("Observation prune-audit month state days must be an array");
  }
  const days = value.days
    .map((entry) => normalizeAuditDay(entry, normalizedYear, normalizedMonth))
    .sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  mapUniqueByDay(days, "Observation prune-audit month state");
  return {
    schema_version: PRUNE_AUDIT_SCHEMA_VERSION,
    kind: PRUNE_AUDIT_KIND,
    backup_version: "v2",
    domain: "observation_prune_audit",
    year: normalizedYear,
    month: normalizedMonth,
    days,
  };
}

export function selectObservationPruneAuditBatch({
  inventoryDays,
  acceptedCopyDays,
  auditCheckpoints,
  alreadyAuditedThisInvocationDays = [],
  maxDays,
}) {
  const limit = requirePositiveInteger(maxDays, "force-prune max days per run");
  if (!Array.isArray(inventoryDays)) {
    throw new Error("Prune-audit inventoryDays must be an array");
  }
  if (!Array.isArray(acceptedCopyDays)) {
    throw new Error("Prune-audit acceptedCopyDays must be an array");
  }
  if (!Array.isArray(auditCheckpoints)) {
    throw new Error("Prune-audit auditCheckpoints must be an array");
  }
  if (!Array.isArray(alreadyAuditedThisInvocationDays)) {
    throw new Error(
      "Prune-audit alreadyAuditedThisInvocationDays must be an array",
    );
  }

  const currentDays = inventoryDays.map((entry) => ({
    ...requireObject(entry, "prune-audit inventory day"),
    day_utc: normalizeDayUtc(entry.day_utc),
    manifest_hash: normalizeManifestHash(
      entry.manifest_hash,
      "prune-audit inventory day manifest_hash",
    ),
  }));
  mapUniqueByDay(currentDays, "Prune-audit inventory");
  const acceptedByDay = mapUniqueByDay(
    acceptedCopyDays.map((entry) => ({
      day_utc: normalizeDayUtc(entry.day_utc),
      manifest_hash: normalizeManifestHash(
        entry.manifest_hash,
        "accepted copy day manifest_hash",
      ),
    })),
    "Accepted observation copy state",
  );
  const auditByDay = mapUniqueByDay(
    auditCheckpoints.map((entry) => normalizeAuditDay(entry)),
    "Observation prune-audit checkpoints",
  );
  const alreadyAudited = new Set(
    alreadyAuditedThisInvocationDays.map((dayUtc) => normalizeDayUtc(dayUtc)),
  );

  const eligible = [];
  let excludedCount = 0;
  for (const current of currentDays) {
    if (acceptedByDay.get(current.day_utc)?.manifest_hash !== current.manifest_hash) {
      excludedCount += 1;
      continue;
    }
    const checkpoint = auditByDay.get(current.day_utc);
    eligible.push({
      ...current,
      last_successful_audit_at:
        checkpoint?.manifest_hash === current.manifest_hash
          ? checkpoint.last_successful_audit_at
          : null,
    });
  }

  eligible.sort((left, right) => {
    const leftNever = left.last_successful_audit_at === null;
    const rightNever = right.last_successful_audit_at === null;
    if (leftNever !== rightNever) return leftNever ? -1 : 1;
    if (!leftNever) {
      const timestampOrder = left.last_successful_audit_at.localeCompare(
        right.last_successful_audit_at,
      );
      if (timestampOrder !== 0) return timestampOrder;
    }
    return left.day_utc.localeCompare(right.day_utc);
  });

  const successfulTimestamps = eligible
    .map((entry) => entry.last_successful_audit_at)
    .filter(Boolean)
    .sort();
  return {
    total_current_days_considered: currentDays.length,
    eligible_days_count: eligible.length,
    excluded_source_identity_not_accepted_count: excludedCount,
    never_successfully_audited_eligible_count: eligible.filter(
      (entry) => entry.last_successful_audit_at === null,
    ).length,
    oldest_successful_audit_at: successfulTimestamps[0] || null,
    already_audited_this_invocation_excluded_count: eligible.filter(
      (entry) => alreadyAudited.has(entry.day_utc),
    ).length,
    selected_days: eligible
      .filter((entry) => !alreadyAudited.has(entry.day_utc))
      .slice(0, limit),
  };
}

export function recordObservationPruneAuditOutcome({
  state,
  day,
  successful,
  dryRun,
  auditedAt,
}) {
  const dayUtc = normalizeDayUtc(day?.day_utc);
  const [year, month] = dayUtc.split("-");
  const current = validateObservationPruneAuditMonthState(state, year, month);
  if (!successful || dryRun) return current;

  const dayMap = mapUniqueByDay(
    current.days.map((entry) => ({ ...entry })),
    "Observation prune-audit month state",
  );
  dayMap.set(dayUtc, {
    day_utc: dayUtc,
    manifest_hash: normalizeManifestHash(
      day.manifest_hash,
      "audited day manifest_hash",
    ),
    last_successful_audit_at: normalizeUtcTimestamp(auditedAt),
  });
  return {
    ...current,
    days: Array.from(dayMap.values())
      .sort((left, right) => left.day_utc.localeCompare(right.day_utc)),
  };
}
