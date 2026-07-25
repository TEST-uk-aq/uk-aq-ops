export const OBSERVATION_HISTORY_SCHEMA_VERSION_V2 = 2;
export const OBSERVATION_HISTORY_SCHEMA_VERSION_V3 = 3;
export const OBSERVATION_HISTORY_WRITER_VERSION_V2 = "parquet-wasm-zstd-v2";
export const OBSERVATION_HISTORY_WRITER_VERSION_V3 = "parquet-wasm-zstd-v3";

export const OBSERVATION_HISTORY_COLUMNS_V2 = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "observed_at_utc",
  "value",
]);

export const OBSERVATION_HISTORY_COLUMNS_V2_STATUS = Object.freeze([
  ...OBSERVATION_HISTORY_COLUMNS_V2,
  "status",
]);

export const OBSERVATION_HISTORY_COLUMNS_V3 = Object.freeze([
  ...OBSERVATION_HISTORY_COLUMNS_V2,
  "verification_status",
]);

function sameColumns(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function cloneDescriptor(descriptor) {
  return {
    history_schema_version: descriptor.history_schema_version,
    columns: [...descriptor.columns],
    writer_version: descriptor.writer_version,
  };
}

export function observationHistoryPhysicalSchemaForColumns(columns) {
  if (sameColumns(columns, OBSERVATION_HISTORY_COLUMNS_V3)) {
    return cloneDescriptor({
      history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
      columns: OBSERVATION_HISTORY_COLUMNS_V3,
      writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    });
  }
  if (
    sameColumns(columns, OBSERVATION_HISTORY_COLUMNS_V2) ||
    sameColumns(columns, OBSERVATION_HISTORY_COLUMNS_V2_STATUS)
  ) {
    return cloneDescriptor({
      history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V2,
      columns,
      writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V2,
    });
  }
  throw new Error(
    `Unsupported observation Parquet physical columns: ${
      Array.isArray(columns) ? columns.join(",") : String(columns)
    }`,
  );
}

export function validateObservationHistoryPhysicalSchema(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Observation physical schema must be an object");
  }
  const expected = observationHistoryPhysicalSchemaForColumns(descriptor.columns);
  if (descriptor.history_schema_version !== expected.history_schema_version) {
    throw new Error("Observation physical history_schema_version does not match columns");
  }
  if (descriptor.writer_version !== expected.writer_version) {
    throw new Error("Observation physical writer_version does not match columns");
  }
  return expected;
}

export function combineObservationHistoryPhysicalSchemas(descriptors) {
  const unique = new Map();
  for (const descriptor of descriptors || []) {
    const validated = validateObservationHistoryPhysicalSchema(descriptor);
    const key = JSON.stringify(validated);
    unique.set(key, validated);
  }
  const physicalSchemas = [...unique.values()].sort((left, right) => {
    if (left.history_schema_version !== right.history_schema_version) {
      return left.history_schema_version - right.history_schema_version;
    }
    return JSON.stringify(left.columns).localeCompare(JSON.stringify(right.columns));
  });
  if (!physicalSchemas.length) {
    return observationHistoryPhysicalSchemaForColumns(
      OBSERVATION_HISTORY_COLUMNS_V3,
    );
  }
  if (physicalSchemas.length === 1) return physicalSchemas[0];
  return {
    history_schema_version: null,
    columns: null,
    writer_version: null,
    physical_schemas: physicalSchemas,
  };
}

export function observationHistoryPhysicalSchemasFromManifest(manifest) {
  if (Array.isArray(manifest?.physical_schemas)) {
    if (manifest.physical_schemas.length < 2) {
      throw new Error("Mixed physical_schemas must contain at least two schemas");
    }
    return manifest.physical_schemas.map(validateObservationHistoryPhysicalSchema);
  }
  return [validateObservationHistoryPhysicalSchema({
    history_schema_version: manifest?.history_schema_version,
    columns: manifest?.columns,
    writer_version: manifest?.writer_version,
  })];
}
