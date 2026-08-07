import { createHash } from "node:crypto";

export const HIERARCHICAL_INVENTORY_SCHEMA_VERSION = 1;
export const HIERARCHICAL_STATE_SCHEMA_VERSION = 1;
export const HIERARCHICAL_INVENTORY_KIND =
  "uk_aq_r2_history_backup_inventory_v2_root";
export const OBSERVATIONS_MONTH_INVENTORY_KIND =
  "uk_aq_r2_history_backup_inventory_observations_month";
export const HIERARCHICAL_STATE_KIND =
  "uk_aq_r2_history_backup_state_v2_root";
export const OBSERVATIONS_MONTH_STATE_KIND =
  "uk_aq_r2_history_backup_state_observations_month";
export const OBSERVATION_RUN_MANIFEST_INVENTORY_KIND =
  "uk_aq_r2_history_backup_inventory_observation_run_manifests";
export const OBSERVATION_RUN_MANIFEST_STATE_KIND =
  "uk_aq_r2_history_backup_state_observation_run_manifests";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_PATTERN = /^\d{4}$/;
const MONTH_PATTERN = /^(0[1-9]|1[0-2])$/;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableSortObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortObject(entry));
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableSortObject(value[key]);
    }
    return sorted;
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableSortObject(value), null, 2)}\n`;
}

export function assertSha256(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex string`);
  }
  return normalized;
}

export function normalizeRelativePath(value, label = "relative path") {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("\0")
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function normalizeYear(value, label = "year") {
  const normalized = String(value ?? "").trim().padStart(4, "0");
  if (!YEAR_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function normalizeMonth(value, label = "month") {
  const normalized = String(value ?? "").trim().padStart(2, "0");
  if (!MONTH_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function normalizeDay(value, label = "day_utc") {
  const normalized = String(value || "").trim();
  const match = ISO_DAY_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`Invalid calendar ${label}: ${value}`);
  }
  return normalized;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function observationMonthInventoryShardKey(
  inventoryRootPrefix,
  year,
  month,
) {
  return `${normalizeRelativePath(inventoryRootPrefix, "inventory root prefix")}`
    + `/observations/year=${normalizeYear(year)}/month=${normalizeMonth(month)}.json`;
}

export function observationMonthStateShardKey(stateRootPrefix, year, month) {
  return `${normalizeRelativePath(stateRootPrefix, "state root prefix")}`
    + `/observations/year=${normalizeYear(year)}/month=${normalizeMonth(month)}.json`;
}

export function buildObservationMonthInventoryShard({
  observationsPrefix,
  year,
  month,
  sourceMonthManifestKey,
  sourceMonthHash,
  days,
}) {
  const normalizedPrefix = normalizeRelativePath(
    observationsPrefix,
    "observations prefix",
  );
  const normalizedYear = normalizeYear(year);
  const normalizedMonth = normalizeMonth(month);
  const normalizedDays = [...days]
    .map((day) => {
      const dayUtc = normalizeDay(day.day_utc);
      if (!dayUtc.startsWith(`${normalizedYear}-${normalizedMonth}-`)) {
        throw new Error(
          `Inventory day ${dayUtc} is outside ${normalizedYear}-${normalizedMonth}`,
        );
      }
      return {
        day_utc: dayUtc,
        relative_path: `${normalizedPrefix}/day_utc=${dayUtc}`,
        manifest_key: normalizeRelativePath(day.manifest_key),
        manifest_hash: assertSha256(day.manifest_hash, `day ${dayUtc} manifest_hash`),
        manifest_file_hash: assertSha256(
          day.manifest_file_hash,
          `day ${dayUtc} manifest_file_hash`,
        ),
        manifest_size: Number.isFinite(Number(day.manifest_size))
          ? Math.max(0, Math.trunc(Number(day.manifest_size)))
          : null,
      };
    })
    .sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  return {
    schema_version: HIERARCHICAL_INVENTORY_SCHEMA_VERSION,
    kind: OBSERVATIONS_MONTH_INVENTORY_KIND,
    backup_version: "v2",
    domain: "observations",
    year: normalizedYear,
    month: normalizedMonth,
    source_month_manifest_key: normalizeRelativePath(sourceMonthManifestKey),
    source_month_hash: assertSha256(
      sourceMonthHash,
      `${normalizedYear}-${normalizedMonth} source_month_hash`,
    ),
    days: normalizedDays,
  };
}

export function validateObservationMonthInventoryShard(shard) {
  const value = assertObject(shard, "observation month inventory shard");
  if (Number(value.schema_version) !== HIERARCHICAL_INVENTORY_SCHEMA_VERSION) {
    throw new Error("Observation month inventory shard schema_version mismatch");
  }
  if (value.kind !== OBSERVATIONS_MONTH_INVENTORY_KIND) {
    throw new Error("Observation month inventory shard kind mismatch");
  }
  if (value.backup_version !== "v2" || value.domain !== "observations") {
    throw new Error("Observation month inventory shard identity mismatch");
  }
  const year = normalizeYear(value.year);
  const month = normalizeMonth(value.month);
  const sourceMonthHash = assertSha256(
    value.source_month_hash,
    "observation month inventory source_month_hash",
  );
  const sourceMonthManifestKey = normalizeRelativePath(
    value.source_month_manifest_key,
  );
  const days = Array.isArray(value.days)
    ? value.days.map((entry) => ({
      day_utc: normalizeDay(entry.day_utc),
      relative_path: normalizeRelativePath(entry.relative_path),
      manifest_key: normalizeRelativePath(entry.manifest_key),
      manifest_hash: assertSha256(entry.manifest_hash, "inventory day manifest_hash"),
      manifest_file_hash: assertSha256(
        entry.manifest_file_hash,
        "inventory day manifest_file_hash",
      ),
      manifest_size: Number.isFinite(Number(entry.manifest_size))
        ? Math.max(0, Math.trunc(Number(entry.manifest_size)))
        : null,
    })).sort((left, right) => left.day_utc.localeCompare(right.day_utc))
    : null;
  if (!days) {
    throw new Error("Observation month inventory days must be an array");
  }
  return {
    ...value,
    year,
    month,
    source_month_hash: sourceMonthHash,
    source_month_manifest_key: sourceMonthManifestKey,
    days,
  };
}

export function buildHierarchicalInventoryRoot({
  observationsRootManifestKey,
  observationsRootHash,
  years,
  runManifestInventoryShardKey,
  runManifestInventoryShardHash,
  runManifestUnitCount,
  legacyInventoryKey,
}) {
  const normalizedYears = [...years]
    .map((yearEntry) => ({
      year: normalizeYear(yearEntry.year),
      manifest_key: normalizeRelativePath(yearEntry.manifest_key),
      content_hash: assertSha256(yearEntry.content_hash, "year content_hash"),
      months: [...yearEntry.months]
        .map((monthEntry) => ({
          month: normalizeMonth(monthEntry.month),
          manifest_key: normalizeRelativePath(monthEntry.manifest_key),
          content_hash: assertSha256(monthEntry.content_hash, "month content_hash"),
          inventory_shard_key: normalizeRelativePath(
            monthEntry.inventory_shard_key,
          ),
        }))
        .sort((left, right) => left.month.localeCompare(right.month)),
    }))
    .sort((left, right) => left.year.localeCompare(right.year));



  return {
    schema_version: HIERARCHICAL_INVENTORY_SCHEMA_VERSION,
    kind: HIERARCHICAL_INVENTORY_KIND,
    backup_version: "v2",
    observations: {
      source_root_manifest_key: normalizeRelativePath(
        observationsRootManifestKey,
      ),
      source_root_hash: assertSha256(
        observationsRootHash,
        "observations source_root_hash",
      ),
      years: normalizedYears,
    },
    global_units: {
      observation_run_manifests: {
        inventory_shard_key: normalizeRelativePath(
          runManifestInventoryShardKey,
        ),
        content_hash: assertSha256(
          runManifestInventoryShardHash,
          "observation run manifest inventory shard hash",
        ),
        unit_count: Number.isFinite(Number(runManifestUnitCount))
          ? Math.max(0, Math.trunc(Number(runManifestUnitCount)))
          : 0,
      },
    },
    compatibility: {
      legacy_inventory_key: normalizeRelativePath(legacyInventoryKey),
    },
  };
}

export function validateHierarchicalInventoryRoot(root) {
  const value = assertObject(root, "hierarchical inventory root");
  if (Number(value.schema_version) !== HIERARCHICAL_INVENTORY_SCHEMA_VERSION) {
    throw new Error("Hierarchical inventory root schema_version mismatch");
  }
  if (value.kind !== HIERARCHICAL_INVENTORY_KIND || value.backup_version !== "v2") {
    throw new Error("Hierarchical inventory root identity mismatch");
  }
  const observations = assertObject(value.observations, "inventory observations");
  const sourceRootHash = assertSha256(
    observations.source_root_hash,
    "inventory observations source_root_hash",
  );
  const sourceRootManifestKey = normalizeRelativePath(
    observations.source_root_manifest_key,
  );
  const years = Array.isArray(observations.years)
    ? observations.years.map((yearEntry) => ({
      year: normalizeYear(yearEntry.year),
      manifest_key: normalizeRelativePath(yearEntry.manifest_key),
      content_hash: assertSha256(yearEntry.content_hash, "inventory year hash"),
      months: Array.isArray(yearEntry.months)
        ? yearEntry.months.map((monthEntry) => ({
          month: normalizeMonth(monthEntry.month),
          manifest_key: normalizeRelativePath(monthEntry.manifest_key),
          content_hash: assertSha256(
            monthEntry.content_hash,
            "inventory month hash",
          ),
          inventory_shard_key: normalizeRelativePath(
            monthEntry.inventory_shard_key,
          ),
        })).sort((left, right) => left.month.localeCompare(right.month))
        : [],
    })).sort((left, right) => left.year.localeCompare(right.year))
    : [];
  const runManifestGlobal = assertObject(
    value.global_units?.observation_run_manifests,
    "inventory observation run manifests global shard",
  );
  const globalUnits = {
    observation_run_manifests: {
      inventory_shard_key: normalizeRelativePath(
        runManifestGlobal.inventory_shard_key,
      ),
      content_hash: assertSha256(
        runManifestGlobal.content_hash,
        "inventory observation run manifests content_hash",
      ),
      unit_count: Number.isFinite(Number(runManifestGlobal.unit_count))
        ? Math.max(0, Math.trunc(Number(runManifestGlobal.unit_count)))
        : 0,
    },
  };
  return {
    ...value,
    observations: {
      ...observations,
      source_root_hash: sourceRootHash,
      source_root_manifest_key: sourceRootManifestKey,
      years,
    },
    global_units: globalUnits,
  };
}

export function buildObservationRunManifestInventoryShard(units = []) {
  const normalizedUnits = [...units]
    .map((entry) => ({
      unit_key: String(entry.unit_key || "").trim(),
      relative_path: normalizeRelativePath(entry.relative_path),
      hash: assertSha256(entry.hash, "run manifest hash"),
      size: Number.isFinite(Number(entry.size))
        ? Math.max(0, Math.trunc(Number(entry.size)))
        : null,
      r2_md5: String(entry.r2_md5 || "").trim() || null,
    }))
    .sort((left, right) => left.unit_key.localeCompare(right.unit_key));
  const seen = new Set();
  for (const entry of normalizedUnits) {
    if (!entry.unit_key || seen.has(entry.unit_key)) {
      throw new Error(`Invalid or duplicate run manifest unit_key: ${entry.unit_key}`);
    }
    seen.add(entry.unit_key);
  }
  return {
    schema_version: HIERARCHICAL_INVENTORY_SCHEMA_VERSION,
    kind: OBSERVATION_RUN_MANIFEST_INVENTORY_KIND,
    backup_version: "v2",
    units: normalizedUnits,
  };
}

export function validateObservationRunManifestInventoryShard(shard) {
  const value = assertObject(shard, "observation run manifest inventory shard");
  if (
    Number(value.schema_version) !== HIERARCHICAL_INVENTORY_SCHEMA_VERSION
    || value.kind !== OBSERVATION_RUN_MANIFEST_INVENTORY_KIND
    || value.backup_version !== "v2"
  ) {
    throw new Error("Observation run manifest inventory shard identity mismatch");
  }
  return buildObservationRunManifestInventoryShard(value.units || []);
}

export function buildObservationRunManifestStateShard(units = []) {
  const normalizedUnits = [...units]
    .map((entry) => ({
      unit_key: String(entry.unit_key || "").trim(),
      hash: assertSha256(entry.hash, "run manifest state hash"),
      copied_at: String(entry.copied_at || "").trim() || null,
    }))
    .sort((left, right) => left.unit_key.localeCompare(right.unit_key));
  const seen = new Set();
  for (const entry of normalizedUnits) {
    if (!entry.unit_key || seen.has(entry.unit_key)) {
      throw new Error(`Invalid or duplicate run manifest state unit_key: ${entry.unit_key}`);
    }
    seen.add(entry.unit_key);
  }
  return {
    schema_version: HIERARCHICAL_STATE_SCHEMA_VERSION,
    kind: OBSERVATION_RUN_MANIFEST_STATE_KIND,
    backup_version: "v2",
    processed_source_hash: null,
    units: normalizedUnits,
  };
}

export function validateObservationRunManifestStateShard(shard) {
  if (!shard) return buildObservationRunManifestStateShard([]);
  const value = assertObject(shard, "observation run manifest state shard");
  if (
    Number(value.schema_version) !== HIERARCHICAL_STATE_SCHEMA_VERSION
    || value.kind !== OBSERVATION_RUN_MANIFEST_STATE_KIND
    || value.backup_version !== "v2"
  ) {
    throw new Error("Observation run manifest state shard identity mismatch");
  }
  const normalized = buildObservationRunManifestStateShard(value.units || []);
  normalized.processed_source_hash = value.processed_source_hash
    ? assertSha256(
      value.processed_source_hash,
      "run manifest state processed_source_hash",
    )
    : null;
  return normalized;
}

export function emptyObservationMonthState(year, month) {
  return {
    schema_version: HIERARCHICAL_STATE_SCHEMA_VERSION,
    kind: OBSERVATIONS_MONTH_STATE_KIND,
    backup_version: "v2",
    domain: "observations",
    year: normalizeYear(year),
    month: normalizeMonth(month),
    processed_source_month_hash: null,
    days: [],
  };
}

export function validateObservationMonthState(state, year, month) {
  if (!state) return emptyObservationMonthState(year, month);
  const value = assertObject(state, "observation month state");
  if (Number(value.schema_version) !== HIERARCHICAL_STATE_SCHEMA_VERSION) {
    throw new Error("Observation month state schema_version mismatch");
  }
  if (
    value.kind !== OBSERVATIONS_MONTH_STATE_KIND
    || value.backup_version !== "v2"
    || value.domain !== "observations"
  ) {
    throw new Error("Observation month state identity mismatch");
  }
  const normalizedYear = normalizeYear(year);
  const normalizedMonth = normalizeMonth(month);
  if (
    normalizeYear(value.year) !== normalizedYear
    || normalizeMonth(value.month) !== normalizedMonth
  ) {
    throw new Error("Observation month state path identity mismatch");
  }
  const days = Array.isArray(value.days)
    ? value.days.map((entry) => ({
      day_utc: normalizeDay(entry.day_utc),
      manifest_hash: assertSha256(entry.manifest_hash, "state day manifest_hash"),
      copied_at: String(entry.copied_at || "").trim() || null,
    })).sort((left, right) => left.day_utc.localeCompare(right.day_utc))
    : [];
  const processed = value.processed_source_month_hash
    ? assertSha256(
      value.processed_source_month_hash,
      "state processed_source_month_hash",
    )
    : null;
  return {
    ...value,
    year: normalizedYear,
    month: normalizedMonth,
    processed_source_month_hash: processed,
    days,
  };
}

export function migrateLegacyMonthState({
  inventoryShard,
  legacyState,
}) {
  const inventory = validateObservationMonthInventoryShard(inventoryShard);
  const state = emptyObservationMonthState(inventory.year, inventory.month);
  const legacyDays = legacyState?.domains?.observations?.days;
  const sourceDays = legacyDays && typeof legacyDays === "object"
    ? legacyDays
    : {};
  state.days = inventory.days.flatMap((day) => {
    const legacy = sourceDays[day.day_utc];
    const legacyHash = String(legacy?.manifest_hash || "").trim().toLowerCase();
    if (
      legacyHash !== day.manifest_file_hash
      && legacyHash !== day.manifest_hash
    ) return [];
    return [{
      day_utc: day.day_utc,
      manifest_hash: day.manifest_hash,
      copied_at: String(legacy?.copied_at || "").trim() || null,
    }];
  });
  if (monthStateIsComplete(state, inventory)) {
    state.processed_source_month_hash = inventory.source_month_hash;
  }
  return state;
}

export function monthStateDayMap(state) {
  return new Map(
    (Array.isArray(state?.days) ? state.days : [])
      .map((entry) => [String(entry.day_utc), entry]),
  );
}

export function monthStateIsComplete(state, inventoryShard) {
  const inventory = validateObservationMonthInventoryShard(inventoryShard);
  const stateValue = validateObservationMonthState(
    state,
    inventory.year,
    inventory.month,
  );
  const stateDays = monthStateDayMap(stateValue);
  return inventory.days.every(
    (day) => stateDays.get(day.day_utc)?.manifest_hash === day.manifest_hash,
  );
}

export function planObservationMonthCopies(state, inventoryShard) {
  const inventory = validateObservationMonthInventoryShard(inventoryShard);
  const stateValue = validateObservationMonthState(
    state,
    inventory.year,
    inventory.month,
  );
  if (stateValue.processed_source_month_hash === inventory.source_month_hash) {
    return [];
  }
  const stateDays = monthStateDayMap(stateValue);
  return inventory.days.filter(
    (day) => stateDays.get(day.day_utc)?.manifest_hash !== day.manifest_hash,
  );
}

export function markObservationDayCopied(state, dayEntry, copiedAt) {
  const current = validateObservationMonthState(
    state,
    state.year,
    state.month,
  );
  const dayUtc = normalizeDay(dayEntry.day_utc);
  const manifestHash = assertSha256(dayEntry.manifest_hash, "copied day hash");
  const dayMap = monthStateDayMap(current);
  dayMap.set(dayUtc, {
    day_utc: dayUtc,
    manifest_hash: manifestHash,
    copied_at: String(copiedAt || "").trim() || null,
  });
  current.days = Array.from(dayMap.values())
    .sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  current.processed_source_month_hash = null;
  return current;
}

export function completeObservationMonthState(state, inventoryShard) {
  const inventory = validateObservationMonthInventoryShard(inventoryShard);
  const current = validateObservationMonthState(
    state,
    inventory.year,
    inventory.month,
  );
  if (!monthStateIsComplete(current, inventory)) {
    throw new Error(
      `Cannot complete observation month ${inventory.year}-${inventory.month}: `
      + "one or more day identities are incomplete",
    );
  }
  current.processed_source_month_hash = inventory.source_month_hash;
  return current;
}

export function emptyHierarchicalStateRoot(legacyStateKey) {
  return {
    schema_version: HIERARCHICAL_STATE_SCHEMA_VERSION,
    kind: HIERARCHICAL_STATE_KIND,
    backup_version: "v2",
    observations: {
      processed_source_root_hash: null,
      years: [],
    },
    global_units: {
      observation_run_manifests: {
        state_shard_key:
          "_ops/checkpoints/r2_history_backup_state_v2/global/observation_run_manifests.json",
        processed_source_hash: null,
        state_shard_hash: null,
      },
    },
    compatibility: {
      legacy_state_key: normalizeRelativePath(legacyStateKey),
    },
  };
}

export function validateHierarchicalStateRoot(root, legacyStateKey) {
  if (!root) return emptyHierarchicalStateRoot(legacyStateKey);
  const value = assertObject(root, "hierarchical state root");
  if (Number(value.schema_version) !== HIERARCHICAL_STATE_SCHEMA_VERSION) {
    throw new Error("Hierarchical state root schema_version mismatch");
  }
  if (value.kind !== HIERARCHICAL_STATE_KIND || value.backup_version !== "v2") {
    throw new Error("Hierarchical state root identity mismatch");
  }
  const observations = assertObject(value.observations, "state observations");
  const years = Array.isArray(observations.years)
    ? observations.years.map((yearEntry) => ({
      year: normalizeYear(yearEntry.year),
      processed_source_year_hash: yearEntry.processed_source_year_hash
        ? assertSha256(
          yearEntry.processed_source_year_hash,
          "state processed_source_year_hash",
        )
        : null,
      months: Array.isArray(yearEntry.months)
        ? yearEntry.months.map((monthEntry) => ({
          month: normalizeMonth(monthEntry.month),
          state_shard_key: normalizeRelativePath(monthEntry.state_shard_key),
          processed_source_month_hash: monthEntry.processed_source_month_hash
            ? assertSha256(
              monthEntry.processed_source_month_hash,
              "state processed_source_month_hash",
            )
            : null,
          state_shard_hash: monthEntry.state_shard_hash
            ? assertSha256(monthEntry.state_shard_hash, "state shard hash")
            : null,
        })).sort((left, right) => left.month.localeCompare(right.month))
        : [],
    })).sort((left, right) => left.year.localeCompare(right.year))
    : [];
  return {
    ...value,
    observations: {
      processed_source_root_hash: observations.processed_source_root_hash
        ? assertSha256(
          observations.processed_source_root_hash,
          "state processed_source_root_hash",
        )
        : null,
      years,
    },
    global_units: {
      observation_run_manifests: {
        state_shard_key: normalizeRelativePath(
          value.global_units?.observation_run_manifests?.state_shard_key
          || "_ops/checkpoints/r2_history_backup_state_v2/global/observation_run_manifests.json",
        ),
        processed_source_hash:
          value.global_units?.observation_run_manifests?.processed_source_hash
            ? assertSha256(
              value.global_units.observation_run_manifests.processed_source_hash,
              "state run manifest processed_source_hash",
            )
            : null,
        state_shard_hash:
          value.global_units?.observation_run_manifests?.state_shard_hash
            ? assertSha256(
              value.global_units.observation_run_manifests.state_shard_hash,
              "state run manifest state_shard_hash",
            )
            : null,
      },
    },
    compatibility: {
      legacy_state_key: normalizeRelativePath(
        value.compatibility?.legacy_state_key || legacyStateKey,
      ),
    },
  };
}

export function upsertStateMonthSummary(
  stateRoot,
  {
    year,
    month,
    stateShardKey,
    processedSourceMonthHash,
    stateShardHash,
  },
) {
  const state = validateHierarchicalStateRoot(
    stateRoot,
    stateRoot?.compatibility?.legacy_state_key || "_ops/checkpoints/r2_history_backup_state_v2.json",
  );
  const normalizedYear = normalizeYear(year);
  const normalizedMonth = normalizeMonth(month);
  let yearEntry = state.observations.years.find(
    (entry) => entry.year === normalizedYear,
  );
  if (!yearEntry) {
    yearEntry = {
      year: normalizedYear,
      processed_source_year_hash: null,
      months: [],
    };
    state.observations.years.push(yearEntry);
    state.observations.years.sort((a, b) => a.year.localeCompare(b.year));
  }
  let monthEntry = yearEntry.months.find(
    (entry) => entry.month === normalizedMonth,
  );
  if (!monthEntry) {
    monthEntry = {
      month: normalizedMonth,
      state_shard_key: normalizeRelativePath(stateShardKey),
      processed_source_month_hash: null,
      state_shard_hash: null,
    };
    yearEntry.months.push(monthEntry);
    yearEntry.months.sort((a, b) => a.month.localeCompare(b.month));
  }
  monthEntry.state_shard_key = normalizeRelativePath(stateShardKey);
  monthEntry.processed_source_month_hash = processedSourceMonthHash
    ? assertSha256(processedSourceMonthHash, "processed source month hash")
    : null;
  monthEntry.state_shard_hash = stateShardHash
    ? assertSha256(stateShardHash, "state shard hash")
    : null;
  yearEntry.processed_source_year_hash = null;
  state.observations.processed_source_root_hash = null;
  Object.assign(stateRoot, state);
  return stateRoot;
}

export function setStateYearProcessedHash(stateRoot, year, sourceYearHash) {
  const state = validateHierarchicalStateRoot(
    stateRoot,
    stateRoot.compatibility.legacy_state_key,
  );
  const normalizedYear = normalizeYear(year);
  const yearEntry = state.observations.years.find(
    (entry) => entry.year === normalizedYear,
  );
  if (!yearEntry) {
    throw new Error(`Cannot complete missing state year ${normalizedYear}`);
  }
  yearEntry.processed_source_year_hash = assertSha256(
    sourceYearHash,
    "processed source year hash",
  );
  state.observations.processed_source_root_hash = null;
  Object.assign(stateRoot, state);
  return stateRoot;
}

export function setStateRootProcessedHash(stateRoot, sourceRootHash) {
  const state = validateHierarchicalStateRoot(
    stateRoot,
    stateRoot.compatibility.legacy_state_key,
  );
  state.observations.processed_source_root_hash = assertSha256(
    sourceRootHash,
    "processed source root hash",
  );
  Object.assign(stateRoot, state);
  return stateRoot;
}

export function stateYearEntry(stateRoot, year) {
  const normalizedYear = normalizeYear(year);
  return stateRoot?.observations?.years?.find(
    (entry) => entry.year === normalizedYear,
  ) || null;
}

export function stateMonthEntry(stateRoot, year, month) {
  const yearEntry = stateYearEntry(stateRoot, year);
  const normalizedMonth = normalizeMonth(month);
  return yearEntry?.months?.find((entry) => entry.month === normalizedMonth) || null;
}
